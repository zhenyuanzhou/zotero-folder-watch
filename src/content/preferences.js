/* global Zotero, ChromeUtils, document, window */

// Pane scripts run in a sandbox whose prototype is the prefs window, and they
// run BEFORE the pane markup is inserted into the document. Inline oncommand
// handlers are compiled in the window scope, so the helper object must be
// attached to `window`, and element setup must wait until the markup exists.

var FolderWatchPrefs = {
	PATHS_PREF: "extensions.zotero.folderwatch.paths",
	_choosing: false,

	getPaths() {
		try {
			let raw = Zotero.Prefs.get(this.PATHS_PREF, true);
			let arr = raw ? JSON.parse(raw) : [];
			if (Array.isArray(arr)) {
				return arr.filter(p => typeof p === "string" && p);
			}
		}
		catch (e) {}
		return [];
	},

	setPaths(paths) {
		Zotero.Prefs.set(this.PATHS_PREF, JSON.stringify(paths), true);
		this.rebuildList();
	},

	rebuildList() {
		let list = document.getElementById("folderwatch-list");
		while (list.firstChild) {
			list.firstChild.remove();
		}
		for (let path of this.getPaths()) {
			let item = document.createXULElement("richlistitem");
			item.setAttribute("value", path);
			let label = document.createXULElement("label");
			label.setAttribute("value", path);
			label.setAttribute("crop", "start");
			item.appendChild(label);
			list.appendChild(item);
		}
	},

	addPath(path) {
		path = (path || "").trim();
		if (!path) {
			return;
		}
		let paths = this.getPaths();
		if (!paths.includes(path)) {
			paths.push(path);
			this.setPaths(paths);
		}
	},

	async addFolder() {
		if (this._choosing) {
			return;
		}
		this._choosing = true;
		try {
			let { FilePicker } = ChromeUtils.importESModule(
				"chrome://zotero/content/modules/filePicker.mjs"
			);
			let fp = new FilePicker();
			fp.init(window, "Select folder to watch", fp.modeGetFolder);
			fp.appendFilters(fp.filterAll);
			if ((await fp.show()) === fp.returnOK && fp.file) {
				this.addPath(fp.file);
			}
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.alert(window, "Folder Watch",
				"Could not open the folder picker: " + e
				+ "\n\nYou can paste the folder path into the text box instead.");
		}
		finally {
			this._choosing = false;
		}
	},

	addManual() {
		let input = document.getElementById("folderwatch-manual");
		this.addPath(input.value);
		input.value = "";
	},

	removeSelected() {
		let list = document.getElementById("folderwatch-list");
		let selected = list.selectedItem;
		if (!selected) {
			return;
		}
		let path = selected.getAttribute("value");
		this.setPaths(this.getPaths().filter(p => p !== path));
	},

	init() {
		try {
			this.rebuildList();

			// Backup wiring in case the inline oncommand isn't activated;
			// the guards above keep dual wiring from acting twice
			document.getElementById("folderwatch-add")
				.addEventListener("command", () => this.addFolder());
			document.getElementById("folderwatch-add-manual")
				.addEventListener("command", () => this.addManual());
			document.getElementById("folderwatch-remove")
				.addEventListener("command", () => this.removeSelected());

			Zotero.debug("FolderWatch: preferences pane initialized");
		}
		catch (e) {
			Zotero.logError(e);
		}
	},
};

// Expose on the real window so inline oncommand handlers (compiled in window
// scope) can find it
window.FolderWatchPrefs = FolderWatchPrefs;

// The pane markup doesn't exist yet when this script runs; poll until it
// appears, then initialize
var FolderWatch_initTries = 0;
var FolderWatch_initTimer = window.setInterval(() => {
	if (document.getElementById("folderwatch-list")) {
		window.clearInterval(FolderWatch_initTimer);
		FolderWatchPrefs.init();
	}
	else if (++FolderWatch_initTries > 200) {
		window.clearInterval(FolderWatch_initTimer);
		Zotero.debug("FolderWatch: preferences pane elements never appeared");
	}
}, 50);
