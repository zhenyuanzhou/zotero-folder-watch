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

		loadProcessed() {
			try {
				return JSON.parse(this.getPref("processed") || "{}");
			}
			catch (e) {
				return {};
			}
		},

		saveProcessed(map) {
			Zotero.Prefs.set(this.prefKey("processed"), JSON.stringify(map), true);
		},

		async start() {
			this.running = true;
			log("watcher started (enabled=" + this.getPref("enabled")
				+ ", paths=" + JSON.stringify(this.getPaths()) + ")");
			while (this.running) {
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
					let relKey = [...relParts, name].join("/");
					out.push({
						path,
						name,
						key: root + "|" + relKey,
						// Bookkeeping key used by versions before multi-folder
						// support; checked for migration
						relKey,
						folders: relParts,
						size: stat.size,
					});
				}
			}
		},

		async scan() {
			let roots = this.getPaths();
			if (!roots.length) {
				return;
			}

			let processed = this.loadProcessed();
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

				if (processed[entry.key]) {
					continue;
				}
				// Imported by a pre-multi-folder version: adopt the new key
				if (processed[entry.relKey]) {
					processed[entry.key] = true;
					continue;
				}

				// Wait until the size is unchanged since the previous scan
				if (this.pending.get(entry.key) !== entry.size) {
					this.pending.set(entry.key, entry.size);
					continue;
				}
				this.pending.delete(entry.key);

				try {
					await this.importFile(entry);
					processed[entry.key] = true;
					importedNames.push(entry.name);
					log("imported " + entry.path);
				}
				catch (e) {
					Zotero.logError(e);
				}
			}

			// Forget files that were removed from the folder, and stale
			// pending entries, so the bookkeeping doesn't grow forever
			for (let name of Object.keys(processed)) {
				if (!seen.has(name)) {
					delete processed[name];
				}
			}
			for (let name of this.pending.keys()) {
				if (!seen.has(name)) {
					this.pending.delete(name);
				}
			}

			this.saveProcessed(processed);

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
