# Run while the rsync tab hangs. Changes nothing. Collects the processes
# involved, the bridge's named pipes and both step logs, and writes
# windows-hang-report.txt next to itself.
$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.Generic.List[string]
function Add([string]$text) { $lines.Add($text); Write-Host $text }

Add "== date: $(Get-Date -Format s)"
Add "== processes (rsync, powershell, Tabby children):"
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(rsync|powershell|bash|sh|conhost|OpenConsole)\.exe$' }
foreach ($p in $procs) {
    Add ("   pid {0} parent {1} {2}" -f $p.ProcessId, $p.ParentProcessId, $p.Name)
    Add ("      cmd: {0}" -f $p.CommandLine)
}

Add "== bridge pipes:"
try {
    [System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*tabby-rsync*' } | ForEach-Object { Add "   $_" }
} catch { Add "   could not list pipes: $($_.Exception.Message)" }

Add "== bridge folders in $env:TEMP:"
$dirs = Get-ChildItem $env:TEMP -Directory -Filter 'tabby-rsync-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime
if (-not $dirs) { Add "   none" }
foreach ($d in $dirs) {
    Add "-- $($d.FullName) ($($d.LastWriteTime))"
    Get-ChildItem $d.FullName | ForEach-Object { Add "   file: $($_.Name) ($($_.Length) bytes)" }
    foreach ($log in @('bridge.log', 'helper.log')) {
        $path = Join-Path $d.FullName $log
        if (Test-Path $path) {
            Add "   --- $log"
            Get-Content $path | ForEach-Object { Add "   $_" }
        } else {
            Add "   --- $log: missing"
        }
    }
}

$target = Join-Path $PSScriptRoot 'windows-hang-report.txt'
try {
    $lines | Set-Content -Path $target -Encoding UTF8 -ErrorAction Stop
    Write-Host "Report written to $target"
} catch {
    Write-Host "Could not write $target : $($_.Exception.Message)"
}
