# Builds zotero-folder-watch.xpi from the src\ folder.
# Run: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$src = Join-Path $root 'src'
$out = Join-Path $root 'zotero-folder-watch.xpi'

if (Test-Path $out) { Remove-Item $out -Force }

# Zip entry names must use forward slashes or Zotero cannot load the files
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
    Get-ChildItem $src -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Built $out"
