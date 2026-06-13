/* global Zotero, IOUtils, PathUtils, ChromeUtils, Components */

var FolderWatch;

// IOUtils/PathUtils may not be in the bootstrap sandbox in all Zotero versions
if (typeof IOUtils === "undefined") {
	try {
		Components.utils.importGlobalProperties(["IOUtils", "PathUtils"]);
	}
	catch (e) {}
}

var { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
	Zotero.debug("FolderWatch: " + msg);
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	FolderWatch = {
		id,
		version,
		rootURI,
		running: false,
		// Files seen on the previous scan but not yet imported, mapped to
		// their size at that time. A file is only imported once its size is
		// stable across two consecutive scans, so half-downloaded PDFs are
		// not picked up.
		pending: new Map(),

		prefKey(key) {
			return "extensions.zotero.folderwatch." + key;
		},

		getPref(key) {
			return Zotero.Prefs.get(this.prefKey(key), true);
		},

		getPaths() {
			try {
				let raw = this.getPref("paths");
				let arr = raw ? JSON.parse(raw) : [];
				if (Array.isArray(arr)) {
					return arr.filter(p => typeof p === "string" && p);
				}
			}
			catch (e) {}
			return [];
		},

		loadJSON(key) {
			try {
				return JSON.parse(this.getPref(key) || "{}");
			}
			catch (e) {
				return {};
			}
		},

		saveJSON(key, obj) {
			Zotero.Prefs.set(this.prefKey(key), JSON.stringify(obj), true);
		},

		async start() {
			this.running = true;
			log("watcher started (enabled=" + this.getPref("enabled")
				+ ", paths=" + JSON.stringify(this.getPaths()) + ")");
			// If another copy of this plugin starts (e.g. after an upgrade
			// where shutdown was never called), it overwrites the token and
			// this loop stops itself instead of running in parallel
			while (this.running && Zotero.__folderWatchToken === this.token) {
				let interval = 30;
				try {
					if (this.getPref("enabled")) {
						await this.scan();
					}
					interval = parseInt(this.getPref("interval")) || 30;
				}
				catch (e) {
					Zotero.logError(e);
					log("scan failed: " + e);
				}
				await delay(Math.max(5, interval) * 1000);
			}
			log("watcher stopped");
		},

		stop() {
			this.running = false;
		},

		// Recursively collect PDFs under dir. Each entry is keyed by its
		// watched root plus relative path so identically named files in
		// different subfolders or different watched folders don't collide.
		async collectPDFs(root, dir, relParts, out) {
			let children;
			try {
				children = await IOUtils.getChildren(dir);
			}
			catch (e) {
				return;
			}
			for (let path of children) {
				let name = PathUtils.filename(path);
				let stat;
				try {
					stat = await IOUtils.stat(path);
				}
				catch (e) {
					continue;
				}
				if (stat.type === "directory") {
					if (!this.getPref("subfolders")) {
						continue;
					}
					// Skip hidden folders and guard against pathological nesting
					if (name.startsWith(".") || relParts.length >= 8) {
						continue;
					}
					await this.collectPDFs(root, path, [...relParts, name], out);
				}
				else if (stat.type === "regular"
						&& name.toLowerCase().endsWith(".pdf")
						&& stat.size > 0) {
					out.push({
						path,
						name,
						key: root + "|" + [...relParts, name].join("/"),
						folders: relParts,
						size: stat.size,
					});
				}
			}
		},

		// Build a map of the PDF content currently present in the library:
		// md5 -> a live attachment item key. Hashes are cached by item key in
		// the "hashes" pref so the whole library is only hashed once; after
		// that each scan only hashes items added since the last scan.
		async buildLibraryIndex() {
			let libraryID = Zotero.Libraries.userLibraryID;
			let cache = this.loadJSON("hashes");
			let freshCache = {};
			let byMd5 = {};

			let items = await Zotero.Items.getAll(libraryID, false, false);
			let hashedThisScan = 0;
			for (let item of items) {
				if (!item.isPDFAttachment() || item.deleted) {
					continue;
				}
				let itemKey = item.key;
				let md5 = cache[itemKey];
				if (!md5) {
					try {
						md5 = await item.attachmentHash;
						hashedThisScan++;
					}
					catch (e) {
						continue;
					}
				}
				if (md5) {
					freshCache[itemKey] = md5;
					if (!byMd5[md5]) {
						byMd5[md5] = itemKey;
					}
				}
			}

			this.saveJSON("hashes", freshCache);
			if (hashedThisScan > 50) {
				log("hashed " + hashedThisScan + " library attachments");
			}
			return byMd5;
		},

		async scan() {
			let roots = this.getPaths();
			if (!roots.length) {
				return;
			}

			let libraryID = Zotero.Libraries.userLibraryID;

			// What content is in the library right now. This is the source of
			// truth: if a file's content isn't here, it gets (re)imported —
			// so deleting an item in Zotero brings it back; if it is here, the
			// file is skipped — so nothing is ever imported twice.
			let liveByMd5 = await this.buildLibraryIndex();

			// Map of disk path -> the library item key we placed it as, pruned
			// to entries whose item is still alive. A live path entry lets us
			// skip re-hashing a file we've already handled.
			let imported = this.loadJSON("imported");
			let livePaths = {};
			for (let fileKey of Object.keys(imported)) {
				let item = Zotero.Items.getByLibraryAndKey(libraryID, imported[fileKey]);
				if (item && !item.deleted) {
					livePaths[fileKey] = imported[fileKey];
				}
			}
			imported = livePaths;

			let entries = [];
			for (let root of roots) {
				if (await IOUtils.exists(root)) {
					await this.collectPDFs(root, root, [], entries);
				}
			}

			let seen = new Set();
			let importedNames = [];

			for (let entry of entries) {
				seen.add(entry.key);

				// Path already placed as a live item — nothing to do
				if (imported[entry.key]) {
					continue;
				}

				// Wait until the size is unchanged since the previous scan, so
				// in-progress downloads/copies aren't imported half-written
				if (this.pending.get(entry.key) !== entry.size) {
					this.pending.set(entry.key, entry.size);
					continue;
				}
				this.pending.delete(entry.key);

				try {
					let md5 = null;
					try {
						md5 = await Zotero.Utilities.Internal.md5Async(entry.path);
					}
					catch (e) {}

					// Content already in the library (possibly under a different
					// name, folder, or added by hand) — just remember the
					// mapping, don't import a duplicate
					if (md5 && liveByMd5[md5]) {
						imported[entry.key] = liveByMd5[md5];
						this.saveJSON("imported", imported);
						continue;
					}

					let attachment = await this.importFile(entry);
					imported[entry.key] = attachment.key;
					if (md5) {
						liveByMd5[md5] = attachment.key;
						let cache = this.loadJSON("hashes");
						cache[attachment.key] = md5;
						this.saveJSON("hashes", cache);
					}
					this.saveJSON("imported", imported);
					importedNames.push(entry.name);
					log("imported " + entry.path);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}

			// Drop path mappings and pending entries for files no longer on
			// disk, so the bookkeeping doesn't grow without bound
			for (let key of Object.keys(imported)) {
				if (!seen.has(key)) {
					delete imported[key];
				}
			}
			for (let key of this.pending.keys()) {
				if (!seen.has(key)) {
					this.pending.delete(key);
				}
			}
			this.saveJSON("imported", imported);

			if (importedNames.length) {
				this.notify(importedNames);
			}
		},

		// Find or create the nested collection chain matching the subfolder
		// path, e.g. ["Machine Learning", "Transformers"] → collection
		// "Machine Learning" containing subcollection "Transformers".
		// Returns the innermost collection's ID.
		async resolveCollection(folders) {
			let libraryID = Zotero.Libraries.userLibraryID;
			let parentID = null;
			for (let name of folders) {
				let siblings = parentID
					? Zotero.Collections.getByParent(parentID)
					: Zotero.Collections.getByLibrary(libraryID);
				let existing = siblings.find(c => c.name === name);
				if (existing) {
					parentID = existing.id;
					continue;
				}
				let collection = new Zotero.Collection();
				collection.libraryID = libraryID;
				collection.name = name;
				if (parentID) {
					collection.parentID = parentID;
				}
				await collection.saveTx();
				log("created collection " + name);
				parentID = collection.id;
			}
			return parentID;
		},

		async importFile(entry) {
			let options = {
				file: entry.path,
				libraryID: Zotero.Libraries.userLibraryID,
			};

			if (entry.folders.length && this.getPref("collections")) {
				let collectionID = await this.resolveCollection(entry.folders);
				if (collectionID) {
					options.collections = [collectionID];
				}
			}

			let attachment = await Zotero.Attachments.importFromFile(options);

			if (this.getPref("recognize")) {
				try {
					await Zotero.RecognizeDocument.autoRecognizeItems([attachment]);
				}
				catch (e) {
					// Metadata retrieval is best-effort; the PDF is already in the library
					Zotero.logError(e);
				}
			}
			return attachment;
		},

		notify(names) {
			try {
				let pw = new Zotero.ProgressWindow();
				pw.changeHeadline("Folder Watch");
				for (let name of names.slice(0, 5)) {
					pw.addDescription("Imported: " + name);
				}
				if (names.length > 5) {
					pw.addDescription("…and " + (names.length - 5) + " more");
				}
				pw.show();
				pw.startCloseTimer(5000);
			}
			catch (e) {
				// No window available; nothing to do
			}
		},
	};

	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + "content/preferences.xhtml",
		scripts: [rootURI + "content/preferences.js"],
		label: "Folder Watch",
		image: rootURI + "icon.svg",
	});

	// Claim the singleton token; any previously running watcher loop (from
	// an upgrade or a failed install) sees the token change and stops
	FolderWatch.token = Date.now() + "-" + Math.random().toString(36).slice(2);
	Zotero.__folderWatchToken = FolderWatch.token;

	// Migrate the single-folder pref from versions before 1.2.0
	if (!FolderWatch.getPaths().length) {
		let oldPath = FolderWatch.getPref("path");
		if (oldPath) {
			Zotero.Prefs.set(FolderWatch.prefKey("paths"),
				JSON.stringify([oldPath]), true);
		}
	}

	await Zotero.uiReadyPromise;
	FolderWatch.start().catch((e) => {
		Zotero.logError(e);
		log("watcher crashed: " + e);
	});
}

function shutdown() {
	if (FolderWatch) {
		FolderWatch.stop();
		FolderWatch = undefined;
	}
}
