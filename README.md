# Zotero Folder Watch

A Zotero 7 plugin that monitors a folder of your choice and automatically
imports any new PDF into your Zotero library — no more adding files by hand.

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
- Already-imported files are remembered by filename, so the same file is not
  imported twice. The original file stays in the watched folder — you can
  delete it afterwards if you like.

Note: on first enable, all PDFs already in the folder are treated as new and
imported. Point the plugin at an empty or dedicated folder if you don't want
that.

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
