# Zotero Folder Watch

A Zotero plugin (compatible with Zotero 7–9) that keeps your library in sync
with one or more folders on disk: any PDF in a watched folder is imported, and
the library is kept as a mirror of those folders — no more adding files by
hand.

## Install

1. Open Zotero 7.
2. Go to **Tools → Plugins**.
3. Click the gear icon (⚙) → **Install Plugin From File…**
4. Select `zotero-folder-watch.xpi`.

## Setup

1. Go to **Edit → Settings** (Windows) and open the **Folder Watch** pane.
2. Click **Choose…** and select the folder to monitor (e.g. your browser's
   download folder or a dedicated "inbox" folder).
3. Optionally adjust the scan interval (default: every 30 seconds) and
   whether metadata should be retrieved automatically.

## How it works

- The plugin scans the watched folder (and, by default, its subfolders) on
  the configured interval.
- PDFs in subfolders are filed into Zotero collections matching the
  subfolder names — `inbox\Machine Learning\Transformers\paper.pdf` goes
  into a "Transformers" collection nested under "Machine Learning",
  creating the collections if needed. Both behaviors can be turned off in
  settings.
- A PDF is imported only after its file size is stable across two
  consecutive scans, so in-progress downloads are not picked up. This means
  a new file appears in Zotero after roughly two scan intervals.
- Each PDF is imported as a stored copy into **My Library**. If
  "retrieve metadata" is enabled, Zotero's built-in PDF recognizer runs and
  creates a proper parent item (title, authors, DOI, …) when it can.

### Mirror model (no duplicates, deletions come back)

The plugin matches files to library items by **content hash (MD5)**, not by
filename, and treats the library as a mirror of the watched folders:

- **Never imports duplicates.** If a file's content is already in the library
  — even under a different name, in a different folder, or added by hand — it
  is skipped. Identical copies of the same PDF only ever produce one item.
- **Restores accidental deletions.** If you delete an item in Zotero but its
  file is still in a watched folder, the next scan re-imports it. To remove
  something permanently, delete the file from the folder too.

The first scan after installing this version hashes the existing library once
to learn what's already there (this can take a while for large libraries);
after that, hashes are cached and only new files are hashed.

Note: on first enable, all PDFs already in a watched folder are imported.
Point the plugin at a dedicated folder if you don't want that.

### Cleaning up earlier duplicates

If an earlier version created duplicate items, run
[`tools/cleanup-duplicates.js`](tools/cleanup-duplicates.js) once via
**Tools → Developer → Run JavaScript** (tick "Run as async function"). It
moves byte-identical duplicates to the Trash, keeping the oldest copy.

## Build from source

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

This repackages `src\` into `zotero-folder-watch.xpi`.

## Source layout

- `src/manifest.json` — plugin metadata (Zotero 7 WebExtension-style manifest)
- `src/bootstrap.js` — plugin lifecycle + the folder-watching/import loop
- `src/prefs.js` — default preferences
- `src/content/preferences.xhtml` / `preferences.js` — settings pane
- `src/icon.svg` — plugin icon
