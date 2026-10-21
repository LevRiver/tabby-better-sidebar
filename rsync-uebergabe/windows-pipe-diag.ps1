# Named pipe diagnosis for the rsync bridge helper. Changes nothing.
# Every step has a timeout, so this script always ends. Writes
# windows-pipe-report.txt next to itself (or to the Desktop / TEMP).
$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.Generic.List[string]
$clock = [System.Diagnostics.Stopwatch]::StartNew()
function Add([string]$text) {
    $line = "[{0,6} ms] {1}" -f $clock.ElapsedMilliseconds, $text
    $lines.Add($line); Write-Host $line
}
function Waited($task, [int]$ms, [string]$what) {
    try {
        if ($task.Wait($ms)) { Add "   ok: $what"; return $true }
        Add "   TIMEOUT after $ms ms: $what"; return $false
    } catch {
        Add "   FAILED: $what -> $($_.Exception.InnerException.Message) $($_.Exception.Message)"; return $false
    }
}

Add "powershell $($PSVersionTable.PSVersion), clr $([Environment]::Version), $env:PROCESSOR_ARCHITECTURE"
$name = 'tabby-diag-' + [guid]::NewGuid().ToString('N')
$server = $null; $client = $null
try {
    # 64 KiB buffers like the real server, Node/libuv. .NET's default is 0,
    # where every write blocks until the other side reads - the first run of
    # this script hung on exactly that, in step B.
    Add "A1 create server (async, byte mode, 64 KiB buffers like Node)"
    $server = New-Object System.IO.Pipes.NamedPipeServerStream($name, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536)
    Add "A2 server.WaitForConnectionAsync"
    $accept = $server.WaitForConnectionAsync()
    Add "A3 create client (async) like the helper"
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    Add "A4 client.Connect(3000)"
    $client.Connect(3000)
    Add "   ok: connected"
    [void](Waited $accept 3000 'server accepted')

    Add "B  client.Write sync -> server.ReadAsync"
    $client.Write([byte[]](65, 66, 67), 0, 3)
    $client.Flush()
    Add "   ok: client wrote 3 bytes"
    $buf = New-Object byte[] 16
    $read = $server.ReadAsync($buf, 0, 16)
    if (Waited $read 3000 'server read') { Add "   got $($read.Result) bytes" }

    Add "C  client.ReadAsync pending, then server writes (helper's receive path)"
    $cbuf = New-Object byte[] 16
    $pendingRead = $client.ReadAsync($cbuf, 0, 16)
    Start-Sleep -Milliseconds 200
    Add "   pending read completed early? $($pendingRead.IsCompleted)"
    $server.Write([byte[]](1, 2, 3, 4), 0, 4)
    $server.Flush()
    if (Waited $pendingRead 3000 'client read') { Add "   got $($pendingRead.Result) bytes" }

    Add "D  client.Write sync WHILE its own ReadAsync is pending (helper's send path)"
    # If this write blocks, the script hangs here - the line above tells.
    $pendingRead = $client.ReadAsync($cbuf, 0, 16)
    try {
        $client.Write([byte[]](7, 7), 0, 2); $client.Flush()
        Add "   ok: write returned with a read pending"
        $read = $server.ReadAsync($buf, 0, 16)
        if (Waited $read 3000 'server read') { Add "   got $($read.Result) bytes" }
    } catch { Add "   FAILED: $($_.Exception.Message)" }

    Add "E  the still-pending client read gets data"
    $server.Write([byte[]](5), 0, 1); $server.Flush()
    if (Waited $pendingRead 3000 'client read') { Add "   got $($pendingRead.Result) bytes" }

    Add "F  Task.WaitAny over two tasks (helper's main loop)"
    $t1 = $client.ReadAsync($cbuf, 0, 16)
    $t2 = [System.Threading.Tasks.Task]::Delay(300)
    $idx = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($t1, $t2), 3000)
    Add "   WaitAny returned index $idx (1 = the delay, expected)"
    $server.Write([byte[]](6), 0, 1); $server.Flush()
    [void](Waited $t1 3000 'read after WaitAny')

    Add "G  stdin as a stream (helper reads rsync's data this way)"
    $stdin = [Console]::OpenStandardInput()
    Add "   stdin stream type: $($stdin.GetType().FullName), redirected: $([Console]::IsInputRedirected)"
} catch {
    Add "EXCEPTION: $($_.Exception.Message)"
} finally {
    if ($client) { $client.Dispose() }
    if ($server) { $server.Dispose() }
}
Add "done"

foreach ($target in @((Join-Path $PSScriptRoot 'windows-pipe-report.txt'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'windows-pipe-report.txt'), (Join-Path $env:TEMP 'windows-pipe-report.txt'))) {
    try {
        $lines | Set-Content -Path $target -Encoding UTF8 -ErrorAction Stop
        Write-Host "Report written to $target"
        break
    } catch {
        Write-Host "Could not write $target : $($_.Exception.Message)"
    }
}
