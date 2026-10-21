import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { Injectable } from '@angular/core'
import { ConfigService, ProfilesService } from 'tabby-core'
import { SFTPPanelComponent } from 'tabby-ssh'
import { SidebarPlusI18nService } from './i18n'
import { RsyncBridge, RsyncExecChannel, RSYNC_BRIDGE_HOST } from './rsyncBridge'

/** The live SSH session, borrowed from the one member that publicly exposes its type. */
type SshSession = SFTPPanelComponent['session']

/** The two calls the bridge needs from russh's `AuthenticatedSSHClient` — typed here, since russh is not. */
interface ExecCapableClient {
    openSessionChannel (): Promise<unknown>
    activateChannel (channel: unknown): Promise<RsyncExecChannel & { requestExec (command: string): Promise<void> }>
}

export interface RsyncBinary {
    path: string
    /** macOS ships `openrsync`, which takes a narrower set of options than rsync 3. */
    flavor: 'rsync'|'openrsync'
    version: string
}

export interface RsyncRequest {
    direction: 'upload'|'download'
    localPath: string
    remotePath: string
    deleteExtra: boolean
    dryRun: boolean
    /** Uploads only: `web` makes everything readable by other users — a web server — `preserve` keeps the local modes. */
    permissions: 'web'|'preserve'
}

/**
 * Additive on purpose: read (and traverse) for everyone, owner keeps write —
 * nothing is taken away, so an executable script stays executable.
 */
const WEB_CHMOD = 'Du+rwx,Dgo+rx,Fu+rw,Fgo+r'

/** Homebrew's rsync first: it is the full rsync 3, where `/usr/bin/rsync` is openrsync on recent macOS. */
const POSIX_RSYNC_CANDIDATES = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync']

const IS_WINDOWS = process.platform === 'win32'

/**
 * Where an rsync for Windows usually lands: on the PATH first, then the
 * default folders of cwRsync (plain, Chocolatey, Scoop), MSYS2 and Cygwin.
 * Windows ships none, and this plugin deliberately bundles none either —
 * the user installs one, and it is found here.
 */
function windowsRsyncCandidates (): string[] {
    const env = process.env
    const onPath = (env.PATH ?? '').split(';').filter(Boolean).map(dir => path.join(dir, 'rsync.exe'))
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter((dir): dir is string => !!dir)
    return [
        ...onPath,
        ...programFiles.map(dir => path.join(dir, 'cwRsync', 'bin', 'rsync.exe')),
        'C:\\cwrsync\\bin\\rsync.exe',
        path.join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'rsync.exe'),
        path.join(os.homedir(), 'scoop', 'shims', 'rsync.exe'),
        'C:\\msys64\\usr\\bin\\rsync.exe',
        'C:\\cygwin64\\bin\\rsync.exe',
    ]
}

/** The helper's interpreter, named in its shebang — see rsyncBridge.ts. */
const PERL = '/usr/bin/perl'

/** Remembered folder pairs per profile; the least recently used go first past this. */
const MAX_REMEMBERED_FOLDERS = 100

/**
 * rsync in a tab of its own, over the SSH session of an SFTP panel.
 *
 * A local terminal tab runs the local rsync, so its output, its prompts and
 * Ctrl+C all work as they do anywhere else; the bridge started for the tab is
 * what reaches the server, and it goes away with the tab.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusRsyncService {
    private binary: RsyncBinary|null = null

    constructor (
        private profiles: ProfilesService,
        private config: ConfigService,
        private i18n: SidebarPlusI18nService,
    ) { }

    /**
     * The local folder to offer for `remotePath`.
     *
     * The folder last paired with it when there is one; otherwise the pairing
     * of its nearest remembered parent, extended by the same relative path —
     * having synchronized `/var/www/site` with `~/site` once is enough for
     * `/var/www/site/css` to come up as `~/site/css`.
     */
    suggestLocalFolder (profileId: string|null, remotePath: string): string|null {
        const remembered = profileId ? this.config.store.sidebarPlus?.rsyncLocalFolders?.[profileId] : null
        if (!remembered) {
            return null
        }
        let current = normalizeRemotePath(remotePath)
        const suffix: string[] = []
        while (true) {
            const local = remembered[current]
            if (local) {
                return suffix.length ? path.join(local, ...suffix.reverse()) : local
            }
            if (current === '/' || current === '.' || !current.includes('/')) {
                return null
            }
            suffix.push(path.posix.basename(current))
            current = path.posix.dirname(current)
        }
    }

    /** Copy-and-reassign, never mutate in place (piège #23). Without a profile there is nothing to key it by. */
    rememberLocalFolder (profileId: string|null, remotePath: string, localPath: string): void {
        if (!profileId) {
            return
        }
        const all: Record<string, Record<string, string>> = { ...(this.config.store.sidebarPlus.rsyncLocalFolders ?? {}) }
        const pairs = { ...(all[profileId] ?? {}) }
        const key = normalizeRemotePath(remotePath)
        // Deleted first so the pair moves to the end: insertion order is the
        // recency order the cap below trims by.
        delete pairs[key]
        pairs[key] = localPath
        const keys = Object.keys(pairs)
        for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_FOLDERS))) {
            delete pairs[stale]
        }
        all[profileId] = pairs
        this.config.store.sidebarPlus.rsyncLocalFolders = all
        this.config.save()
    }

    /**
     * The rsync to use, null when there is none. A find is kept for the rest
     * of the run; a miss is not, so installing rsync needs no Tabby restart.
     */
    locate (): RsyncBinary|null {
        if (this.binary) {
            return this.binary
        }
        for (const candidate of IS_WINDOWS ? windowsRsyncCandidates() : POSIX_RSYNC_CANDIDATES) {
            if (!fs.existsSync(candidate)) {
                continue
            }
            let banner: string
            try {
                banner = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 3000 })
            } catch {
                continue
            }
            if (/openrsync/i.test(banner)) {
                this.binary = { path: candidate, flavor: 'openrsync', version: banner.split('\n')[0].trim() }
            } else {
                const version = /rsync\s+version\s+v?([\d.]+)/i.exec(banner)?.[1] ?? '?'
                this.binary = { path: candidate, flavor: 'rsync', version }
            }
            break
        }
        return this.binary
    }

    /** What to tell someone without rsync — shown under the "not found" error. */
    installHint (): string {
        if (IS_WINDOWS) {
            return this.i18n.t('Install rsync for Windows, e.g. cwRsync or MSYS2 (pacman -S rsync), and put rsync.exe on the PATH.')
        }
        if (process.platform === 'darwin') {
            return this.i18n.t('Install rsync, e.g. with Homebrew: brew install rsync')
        }
        return this.i18n.t('Install rsync with your package manager.')
    }

    /** The arguments rsync gets, `-e` aside — what the dialog previews and what the tab runs. */
    arguments (binary: RsyncBinary, request: RsyncRequest, rshCommand: string): string[] {
        // `-a` minus owner, group and devices: a Mac's uid 501 / gid 20 mean
        // nothing on the server, and a root login would hand them out. On a
        // Windows download, minus permissions as well: Cygwin and MSYS2 turn
        // them into NTFS ACLs, which is how a downloaded folder ends up
        // unreadable to the very user who downloaded it.
        const args = [IS_WINDOWS && request.direction === 'download' ? '-rlt' : '-rlpt', '-z']
        if (request.direction === 'upload' && request.permissions === 'web') {
            // Given to the *server's* rsync, which applies --chmod as it
            // receives the file list (`recv_file_entry()` in rsync 3's
            // flist.c). Asking the local side would do nothing on a stock
            // Mac: openrsync accepts --chmod and silently ignores it. With
            // -p, it also corrects files a previous run left unreadable.
            args.push(`--rsync-path=rsync --chmod=${WEB_CHMOD}`)
        }
        if (binary.flavor === 'rsync') {
            // One overall progress line rather than ten thousand file names.
            args.push('-h', '--info=progress2,stats1')
        } else {
            args.push('-v', '--stats')
        }
        if (request.deleteExtra) {
            args.push('--delete')
        }
        if (request.dryRun) {
            args.push('-n')
        }
        args.push('-e', rshCommand)
        // Trailing slashes on both sides: the *contents* of the source folder
        // land in the destination folder, never a nested copy of it.
        //
        // On Windows the local folder is the tab's working directory and
        // rsync only sees `./`: a `C:\…` path would read as a remote host
        // named "C", and Cygwin (`/cygdrive/c/…`) and MSYS2 (`/c/…`) disagree
        // on the translation. A relative path means the same to both.
        const local = IS_WINDOWS ? './' : withTrailingSlash(request.localPath)
        const remote = `${RSYNC_BRIDGE_HOST}:${quoteForRemoteShell(withTrailingSlash(request.remotePath))}`
        args.push(...request.direction === 'upload' ? [local, remote] : [remote, local])
        return args
    }

    /** The command line shown in the dialog — the bridge stands in as `<bridge>`. */
    preview (binary: RsyncBinary, request: RsyncRequest): string {
        const command = [binary.path, ...this.arguments(binary, request, '<bridge>')]
            .map(arg => /^[\w@%+=:,./<>-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, '\'\\\'\'')}'`)
            .join(' ')
        return IS_WINDOWS ? `cd "${request.localPath}" && ${command}` : command
    }

    async launch (session: SshSession, request: RsyncRequest, title: string): Promise<void> {
        const binary = this.locate()
        if (!binary) {
            throw new Error(this.i18n.t('rsync was not found on this computer'))
        }
        if (!IS_WINDOWS && !fs.existsSync(PERL)) {
            throw new Error(this.i18n.t('The rsync bridge needs Perl ({path})', { path: PERL }))
        }
        const client = session.ssh as unknown as Partial<ExecCapableClient>
        if (typeof client?.openSessionChannel !== 'function' || typeof client.activateChannel !== 'function') {
            throw new Error(this.i18n.t('The SSH session is not ready'))
        }
        const ssh = client as ExecCapableClient
        if (IS_WINDOWS) {
            // The working directory has to exist before the tab can start in
            // it; for an upload, a missing source is rsync's to report.
            if (request.direction === 'download') {
                await fs.promises.mkdir(request.localPath, { recursive: true })
            } else if (!fs.existsSync(request.localPath)) {
                throw new Error(this.i18n.t('{path} does not exist', { path: request.localPath }))
            }
        }
        const bridge = await RsyncBridge.start(async command => {
            const channel = await ssh.activateChannel(await ssh.openSessionChannel())
            await channel.requestExec(command)
            return channel
        })
        try {
            const tab = await this.profiles.openNewTabForProfile({
                type: 'local',
                name: title,
                options: {
                    command: binary.path,
                    args: this.arguments(binary, request, bridge.rshCommand),
                    cwd: IS_WINDOWS ? request.localPath : os.homedir(),
                    // rsync 3.2.4+ escapes remote paths itself unless told
                    // otherwise; with old-style arguments every flavor behaves
                    // alike, and quoteForRemoteShell() does the escaping.
                    //
                    // MSYS2 rewrites anything that looks like a POSIX path
                    // when it starts a Windows program — the PowerShell
                    // helper — so `/var/www/` would reach the server as
                    // `C:/msys64/var/www/`. Switched off for every argument;
                    // Cygwin builds (cwRsync) never do it and ignore this.
                    env: { RSYNC_OLD_ARGS: '1', MSYS2_ARG_CONV_EXCL: '*' },
                    // Without it the tab closes the instant rsync exits, taking
                    // the summary with it.
                    pauseAfterExit: true,
                },
            } as any)
            if (!tab) {
                throw new Error(this.i18n.t('The rsync tab could not be opened'))
            }
            tab.destroyed$.subscribe(() => bridge.dispose())
        } catch (e) {
            bridge.dispose()
            throw e
        }
    }
}

/** Same normalization as the favorites': one folder, one key, slash or not. */
function normalizeRemotePath (p: string): string {
    const normalized = path.posix.normalize(p.trim())
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function withTrailingSlash (p: string): string {
    return p.endsWith('/') ? p : `${p}/`
}

/**
 * Quotes a remote path for the server's shell, which is what reads it: the
 * helper joins rsync's arguments with spaces exactly as ssh does. A leading
 * `~/` stays outside the quotes so the shell still expands it.
 */
function quoteForRemoteShell (p: string): string {
    if (/^[\w@%+=:,./~-]+$/.test(p)) {
        return p
    }
    const home = p.startsWith('~/') ? '~/' : ''
    const rest = p.slice(home.length)
    return `${home}'${rest.replace(/'/g, '\'\\\'\'')}'`
}
