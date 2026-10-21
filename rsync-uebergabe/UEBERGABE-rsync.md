# Übergabe: rsync-Brücke für tabby-better-sidebar (Stand 2026-10-21, abends)

> **Temporärer Ordner** `rsync-uebergabe/`: nur für die Übergabe Mac → Windows-PC. Vor einem Merge entfernen; was bleiben soll, gehört in `.AIRules/` (Roadmap/Journal, Journal nur mit Freigabe).

Prototyp im Branch `feat/rsync-bridge` (abgezweigt von `master` @ 55f6850), als Arbeitsstand committet und auf `fork` (LevRiver) gepusht.

## Worum es geht

Uploads vieler kleiner Dateien über SFTP sind langsam (pro Datei mehrere Round-Trips nacheinander; russh-napi serialisiert zudem alle Requests eines SFTP-Kanals per Mutex). Lösung: rsync in einem eigenen lokalen Tab, das über die **bestehende** SSH-Verbindung des Tabby-Tabs läuft.

Ablauf: SFTP-Browser → Button ⇄ oder Kontextmenü eines Ordners „Mit rsync synchronisieren…“ → Dialog (Richtung, lokaler/entfernter Ordner, Rechte, `--delete`, Probelauf) → lokaler Terminal-Tab startet `rsync -e <Helfer>` → Helfer reicht stdin/stdout über Socket/Pipe an das Plugin → das Plugin öffnet auf der SSH-Session einen exec-Kanal mit `rsync --server …`.

## Dateien (alle neu oder geändert durch diese Arbeit)

- `src/rsyncBridge.ts`: Brücke. Perl-Helfer + Unix-Socket (Mac/Linux), PowerShell-5.1-Helfer + Named Pipe (Windows). Protokoll in beide Richtungen in Frames (`type:u8 len:u32be`), Header-Zeile `token\tcommand\n`. **Enthält Diagnose-Logs** (`bridge.log`, `helper.log` im Brückenordner `%TEMP%\tabby-rsync-*`), vor einem echten Commit wieder entfernen oder hinter einen Schalter legen.
- `src/rsync.service.ts`: rsync finden (Mac: Homebrew, dann `/usr/bin/rsync` = openrsync; Windows: PATH, cwRsync, Chocolatey, Scoop, `C:\msys64`, `C:\cygwin64`), Argumente, Tab öffnen (`openNewTabForProfile` type `local`, `pauseAfterExit`), lokale Ordner pro Server-Ordner merken (`config.store.sidebarPlus.rsyncLocalFolders`, pro Profil, max. 100).
- `src/components/rsyncModal.component.{ts,pug}`: Dialog.
- `src/components/sftpBrowser.component.{ts,pug}`: Button + Kontextmenü + `openRsync()`.
- `src/configProvider.ts` (Default `rsyncLocalFolders`), `src/index.ts` (Modal deklariert), `src/i18n/*.ts` (alle 4 Sprachen, `npm run lint:i18n` grün).

**Nicht in diesem Branch:** die Upload-Wiederholung/Reconnect-Arbeit einer anderen Session (`src/uploadRunner.ts` u. a.). Sie lebt im Branch `fix/sftp-upload-resilience` (ebenfalls auf `fork`); auf dem Mac liegen davon noch uncommittete Reste im Checkout von `feat/rsync-bridge`, die bewusst nicht mitcommittet wurden.

## Entscheidungen und Erkenntnisse

- Tabbys Binary läuft nicht als Node (`ELECTRON_RUN_AS_NODE` wirkungslos), daher Perl bzw. PowerShell als Helfer.
- `-rlpt` statt `-a`: keine Mac-uid/gid auf dem Server. Auf Windows beim Download `-rlt` (sonst NTFS-ACL-Chaos durch Cygwin/MSYS2).
- Rechte „für Webserver lesbar“ (Standard beim Upload): `--rsync-path=rsync --chmod=Du+rwx,Dgo+rx,Fu+rw,Fgo+r`. Der **Server**-rsync wendet `--chmod` beim Empfang an (`recv_file_entry` in flist.c); openrsync auf dem Mac ignoriert `--chmod` lokal stillschweigend. Auf dem Mac gegen den echten Server **bestätigt**.
- `RSYNC_OLD_ARGS=1` + eigenes Quoting der Remote-Pfade; `MSYS2_ARG_CONV_EXCL=*`, damit MSYS2 `/var/www` nicht in `C:/msys64/var/www` umschreibt.
- Windows: Der lokale Ordner wird zum Arbeitsordner des Tabs, rsync sieht nur `./` (Cygwin und MSYS2 übersetzen `C:\` unterschiedlich).
- Windows-Version ist bewusst: nichts mitliefern, nichts herunterladen. Der User installiert rsync selbst, sonst erscheint ein Hinweis (Option 2). Kein tar-Fallback (Entscheidung: „wer nur hochladen will, nutzt SFTP“).

## Getestet

- Mac: Test-Harness (exec-Kanal durch lokalen Prozess ersetzt): 10 001 Dateien hoch und runter identisch, zweiter Lauf 0 B, Fehlerfall Exit 255, Pfade mit Leerzeichen. In Tabby gegen den echten Server: funktioniert, Rechte korrekt.
- Windows 11 ARM64 (Parallels-VM): PowerShell 5.1, Named-Pipe-Muster des Helfers (Diagnoseskript) grün. Tabby 1.0.238, MSYS2-rsync 3.4.4, Plugin installiert.

## Offen: Windows hängt

In Windows-Tabby öffnet sich der rsync-Tab (blinkender Cursor), es passiert nichts. Ursache unbekannt. Verdachtsmomente:
1. PowerShell `-File` könnte Argumente wie `--server` / `-lrtpze.iLsfxCIvu` als eigene Parameter deuten oder verändern (`helper.log` zeigt die empfangenen Argumente).
2. `[Console]::OpenStandardInput().ReadAsync` unter MSYS2-Pipes / ConPTY.
3. MSYS2-rsync startet `powershell.exe` nicht wie erwartet (Prozessliste prüfen).

Nächster Schritt: Build mit Logs installieren, Probelauf starten, **während es hängt** `windows-hang-diag.ps1` ausführen (Prozesse samt Startbefehl, Pipes, `bridge.log`, `helper.log`).

## Hilfsskripte in diesem Ordner

Alle mit `powershell -ExecutionPolicy Bypass -File <skript>` ausführen; Reports landen neben dem Skript.

- `windows-check.ps1`: Bestandsaufnahme (Tabby, Plugin-Ordner inkl. Junction-Erkennung, rsync-Kandidaten, Paketmanager, Pipe-Selbsttest). Ändert nichts.
- `windows-pipe-diag.ps1`: Named-Pipe-Muster des Helfers, jeder Schritt mit Zeitlimit. Ändert nichts. In der VM komplett grün.
- `windows-hang-diag.ps1`: ausführen, **während** der rsync-Tab hängt: Prozesse samt Startbefehl, Pipes der Brücke, `bridge.log`, `helper.log`. Ändert nichts.
- `windows-install-plugin.ps1`: erwartet `tabby-better-sidebar-dev.zip` (dist + package.json) daneben, sichert ein vorhandenes Plugin und entpackt; bricht ab, wenn Tabby läuft oder das Plugin eine Junction ist. Ist das Plugin auf dem Windows-PC per Junction aus diesem Checkout eingehängt (Projektregel), reicht stattdessen `npm run build` und ein kompletter Neustart von `Tabby.exe`.

## Rückweg Mac

Sicherung der alten Plugin-Version: `~/Library/Application Support/tabby/plugins/backup-tabby-better-sidebar-1.0.8`.
