// Cleanup script for duplicate imports: finds items whose PDF attachment
// content (MD5) is identical, keeps the oldest copy, and moves the rest to
// the Trash (recoverable until the Trash is emptied).
//
// Run inside Zotero: Tools -> Developer -> Run JavaScript,
// check "Run as async function", paste this, click Run.

var libraryID = Zotero.Libraries.userLibraryID;
var items = await Zotero.Items.getAll(libraryID, true);
var byHash = {};
var toTrash = [];

for (let item of items) {
	if (item.deleted) {
		continue;
	}

	let att = null;
	if (item.isRegularItem()) {
		for (let id of item.getAttachments()) {
			let a = Zotero.Items.get(id);
			if (a && a.attachmentContentType == "application/pdf") {
				att = a;
				break;
			}
		}
	}
	else if (item.isAttachment()
			&& item.attachmentContentType == "application/pdf") {
		att = item;
	}
	if (!att) {
		continue;
	}

	let path = await att.getFilePathAsync();
	if (!path) {
		continue;
	}
	let md5 = await Zotero.Utilities.Internal.md5Async(path);
	if (!md5) {
		continue;
	}

	if (!byHash[md5]) {
		byHash[md5] = item;
		continue;
	}

	// Keep the copy added first, trash the newer one
	let keep = byHash[md5];
	let drop = item;
	if (drop.dateAdded < keep.dateAdded) {
		let tmp = keep;
		keep = drop;
		drop = tmp;
		byHash[md5] = keep;
	}
	toTrash.push(drop.id);
}

if (toTrash.length) {
	await Zotero.Items.trashTx(toTrash);
}
return "Moved " + toTrash.length + " duplicate item(s) to Trash. "
	+ "Review the Trash and empty it to delete them permanently.";
