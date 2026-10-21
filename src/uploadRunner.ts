import { Subscription } from 'rxjs'
import { FileUpload } from 'tabby-core'
import { SFTPPanelComponent } from 'tabby-ssh'

export type SshSession = SFTPPanelComponent['session']
type SftpSession = SFTPPanelComponent['sftp']

/** Attempts per file while the transport is fine — a lost transport is not the file's fault and does not count. */
const MAX_ATTEMPTS = 3
/** Breathing room before a retry, so a hiccup on the server side has a chance to clear. */
const RETRY_DELAY_MS = 2000
/** How long the liveness probe waits for an answer before calling the transport dead. */
const PROBE_TIMEOUT_MS = 10000

/**
 * One file to send.
 *
 * `open()` rather than a transfer: a `FileUpload` only ever reads forward, so
 * once an attempt has consumed part of it, a retry needs a brand new one.
 */
export interface UploadJob {
    name: string
    remotePath: string
    open: () => Promise<FileUpload>
    /** Releases whatever `open()` was holding in advance — called once the run is over, consumed or not. */
    discard?: () => void
}

export interface UploadHooks {
    /** One attempt died — reported on its own line, whether a retry follows or not. */
    attemptFailed: (transfer: FileUpload, reason: string) => void
    /** The transport is gone: answers the tab's next one, or null when it does not come back. */
    reconnect: (lost: SshSession) => Promise<SshSession|null>
    /** The run is now waiting for a reconnection, with this many files still to send. */
    waiting: (pending: number) => void
    /** The run picked up again on a new transport. */
    resumed: () => void
}

/**
 * A transport held open for the duration of a run.
 *
 * The SSH transport is reference-counted, and the only reference Tabby ever
 * takes is the shell's: `SSHShellSession.destroy()` unrefs it, and at zero
 * `SSHSession.destroy()` disconnects. So a server that closes an idle shell —
 * `TMOUT`, OpenSSH's `ChannelTimeout`, anything that ends the shell channel
 * alone — took the transport down with it, and the SFTP channel carrying the
 * upload along: every file after that one failed at once. The shell sees no
 * traffic during an upload, which is exactly when such a timeout fires.
 *
 * Holding a reference of our own is what keeps the transport up until the last
 * file is through. A disconnect still ends it — `disconnect$` destroys the
 * session whatever its count — which is the case the reconnection covers.
 */
class HeldLink {
    private destroyed = false
    private sftpClosed = false
    private released = false
    private subscriptions = new Subscription()

    constructor (readonly session: SshSession, readonly sftp: SftpSession) {
        session.ref()
        this.subscriptions.add(session.willDestroy$.subscribe(() => this.destroyed = true))
        this.subscriptions.add(sftp.closed$.subscribe(() => this.sftpClosed = true))
    }

    /**
     * Whether the channel still answers.
     *
     * The flags alone are not enough: a disconnect destroys the session from a
     * `setTimeout`, so the upload's rejection usually lands first. A `stat('/')`
     * is the cheapest question with a guaranteed answer on a live server —
     * the root exists even under a chroot.
     */
    async alive (): Promise<boolean> {
        if (this.destroyed || this.sftpClosed) {
            return false
        }
        let timer: ReturnType<typeof setTimeout>|undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)
        })
        try {
            await Promise.race([this.sftp.stat('/'), timeout])
            return !this.destroyed && !this.sftpClosed
        } catch {
            return false
        } finally {
            clearTimeout(timer)
        }
    }

    /** Gives the reference back — unless the session is already destroyed, where a second `destroy()` would only disconnect a dead client again. */
    release (): void {
        if (this.released) {
            return
        }
        this.released = true
        this.subscriptions.unsubscribe()
        if (!this.destroyed) {
            this.session.unref()
        }
    }
}

function delay (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Sends `jobs` one after the other and answers with the names that never made
 * it.
 *
 * Sequential on purpose: one SFTP channel carries them all. A failure on a
 * live transport is retried at the end of the queue, up to `MAX_ATTEMPTS`. A
 * failure on a dead one stops the run instead of burning through the rest of
 * the queue against a closed channel: it waits for the tab to reconnect, then
 * picks up on the new transport with the file that was interrupted —
 * directories recreated first, since the drop may have died before or during
 * their creation.
 */
export async function runUploads (
    session: SshSession,
    sftp: SftpSession,
    directories: string[],
    jobs: UploadJob[],
    hooks: UploadHooks,
): Promise<string[]> {
    let link = new HeldLink(session, sftp)
    const queue = [...jobs]
    const attempts = new Map<UploadJob, number>()
    const failed: string[] = []

    const makeDirectories = async (): Promise<void> => {
        for (const directory of directories) {
            // A directory that already exists is the normal case when merging
            // into an existing tree; the native panel ignores the same failure.
            await link.sftp.mkdir(directory).catch(() => undefined)
        }
    }

    try {
        await makeDirectories()
        while (queue.length) {
            const job = queue.shift()!
            let transfer: FileUpload|null = null
            try {
                transfer = await job.open()
                await link.sftp.upload(job.remotePath, transfer)
                continue
            } catch (e) {
                if (transfer) {
                    hooks.attemptFailed(transfer, String((e as Error)?.message ?? e))
                }
            }

            if (await link.alive()) {
                const tries = (attempts.get(job) ?? 0) + 1
                attempts.set(job, tries)
                if (tries < MAX_ATTEMPTS) {
                    await delay(RETRY_DELAY_MS)
                    queue.push(job)
                } else {
                    failed.push(job.name)
                }
                continue
            }

            hooks.waiting(queue.length + 1)
            const next = await hooks.reconnect(link.session)
            let nextSftp: SftpSession|null = null
            if (next) {
                nextSftp = await next.openSFTP().catch(() => null)
            }
            if (!next || !nextSftp) {
                failed.push(job.name, ...queue.map(rest => rest.name))
                break
            }
            link.release()
            link = new HeldLink(next, nextSftp)
            hooks.resumed()
            await makeDirectories()
            queue.unshift(job)
        }
    } finally {
        link.release()
        for (const job of jobs) {
            job.discard?.()
        }
    }
    return failed
}
