# Installs the dev build of tabby-better-sidebar into Windows Tabby.
# Backs up an existing copy first; refuses to touch a junction (a repo
# checkout mounted as the plugin), since unzipping there would overwrite
# that checkout's dist folder.
$ErrorActionPreference = 'Stop'
$zip = Join-Path $PSScriptRoot 'tabby-better-sidebar-dev.zip'
$plugins = Join-Path $env:APPDATA 'tabby\plugins'
$modules = Join-Path $plugins 'node_modules'
$target = Join-Path $modules 'tabby-better-sidebar'

if (Get-Process -Name Tabby -ErrorAction SilentlyContinue) {
    Write-Host "Tabby is running - quit it completely first (tray icon too), then run this again."
    exit 1
}
if (-not (Test-Path $zip)) { Write-Host "Missing $zip"; exit 1 }

if (Test-Path $target) {
    $item = Get-Item $target
    if ($item.LinkType) {
        Write-Host "$target is a $($item.LinkType) to $($item.Target) - not touching it."
        exit 1
    }
    $backup = Join-Path $plugins ('backup-tabby-better-sidebar-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item $target $backup -Recurse
    Write-Host "Backed up the existing plugin to $backup"
    Remove-Item (Join-Path $target 'dist') -Recurse -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
}

Expand-Archive -Path $zip -DestinationPath $target -Force
$version = (Get-Content (Join-Path $target 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Installed tabby-better-sidebar $version into $target"
Write-Host "Start Tabby now."
