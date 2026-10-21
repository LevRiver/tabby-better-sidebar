# Read-only check of the Windows side for the rsync bridge test.
# Changes nothing. Writes windows-report.txt next to this script.
$ErrorActionPreference = 'Continue'
$report = Join-Path $PSScriptRoot 'windows-report.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Add([string]$text) { $lines.Add($text); Write-Host $text }

Add "== date: $(Get-Date -Format s)"
Add "== windows: $([Environment]::OSVersion.VersionString) / $env:PROCESSOR_ARCHITECTURE"
Add "== powershell: $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Add "== script folder: $PSScriptRoot"
Add "== temp: $env:TEMP"

Add "== execution policy:"
Get-ExecutionPolicy -List | ForEach-Object { Add ("   {0,-14} {1}" -f $_.Scope, $_.ExecutionPolicy) }

Add "== tabby executable:"
$tabbyCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Tabby\Tabby.exe'),
    (Join-Path $env:ProgramFiles 'Tabby\Tabby.exe')
)
foreach ($c in $tabbyCandidates) { if (Test-Path $c) { Add "   found: $c ($((Get-Item $c).VersionInfo.ProductVersion))" } }
$running = Get-Process -Name Tabby -ErrorAction SilentlyContinue
Add "   running processes: $(@($running).Count)"

Add "== plugin folder:"
$plugins = Join-Path $env:APPDATA 'tabby\plugins\node_modules'
$plugin = Join-Path $plugins 'tabby-better-sidebar'
if (Test-Path $plugin) {
    $item = Get-Item $plugin
    Add "   path: $plugin"
    Add "   link type: '$($item.LinkType)' target: '$($item.Target)'"
    $pkg = Join-Path $plugin 'package.json'
    if (Test-Path $pkg) { Add "   version: $((Get-Content $pkg -Raw | ConvertFrom-Json).version)" }
} else {
    Add "   not installed at $plugin"
    if (Test-Path $plugins) { Get-ChildItem $plugins | ForEach-Object { Add "   other plugin: $($_.Name)" } }
}

Add "== rsync candidates:"
$candidates = @()
$candidates += ($env:PATH -split ';' | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'rsync.exe' })
foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) { if ($pf) { $candidates += (Join-Path $pf 'cwRsync\bin\rsync.exe') } }
$candidates += 'C:\cwrsync\bin\rsync.exe'
$candidates += (Join-Path $env:ProgramData 'chocolatey\bin\rsync.exe')
$candidates += (Join-Path $env:USERPROFILE 'scoop\shims\rsync.exe')
$candidates += 'C:\msys64\usr\bin\rsync.exe'
$candidates += 'C:\cygwin64\bin\rsync.exe'
$found = $false
foreach ($c in $candidates) {
    if (Test-Path $c) {
        $found = $true
        $v = (& $c --version 2>&1 | Select-Object -First 1)
        Add "   found: $c -> $v"
    }
}
if (-not $found) { Add "   none" }
Add "   msys2 present: $(Test-Path 'C:\msys64\usr\bin\bash.exe')"

Add "== package managers:"
foreach ($tool in @('winget', 'choco', 'scoop')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    Add ("   {0}: {1}" -f $tool, $(if ($cmd) { $cmd.Source } else { 'no' }))
}

Add "== named pipe smoke test:"
try {
    $name = 'tabby-check-' + [guid]::NewGuid().ToString('N')
    $server = New-Object System.IO.Pipes.NamedPipeServerStream($name, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536)
    $wait = $server.WaitForConnectionAsync()
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(2000)
    [void]$wait.Wait(2000)
    $client.Write([byte[]](104, 105), 0, 2)
    $buf = New-Object byte[] 2
    $n = $server.ReadAsync($buf, 0, 2).Result
    Add "   ok ($n bytes: $([System.Text.Encoding]::ASCII.GetString($buf)))"
    $client.Dispose(); $server.Dispose()
} catch {
    Add "   failed: $($_.Exception.Message)"
}

# The share may refuse writes; the Desktop is the fallback (with Parallels'
# "Shared Profile" it is the Mac's Desktop as well).
foreach ($target in @($report, (Join-Path ([Environment]::GetFolderPath('Desktop')) 'windows-report.txt'), (Join-Path $env:TEMP 'windows-report.txt'))) {
    try {
        $lines | Set-Content -Path $target -Encoding UTF8 -ErrorAction Stop
        Write-Host ""
        Write-Host "Report written to $target"
        break
    } catch {
        Write-Host "Could not write $target : $($_.Exception.Message)"
    }
}
