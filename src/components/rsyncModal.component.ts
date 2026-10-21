import { Component, Input, OnInit } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { electronRemote } from '../electronRemote'
import { SidebarPlusI18nService } from '../i18n'
import { RsyncBinary, RsyncRequest, SidebarPlusRsyncService } from '../rsync.service'

/**
 * What an rsync run should do, asked before its tab opens.
 *
 * Deliberately small: a direction, two folders, the two options that change
 * what ends up on disk. Anything finer is one edit away in the command the
 * dialog shows — which is also why the preview is there at all.
 */
@Component({
    selector: 'sidebar-plus-rsync-modal',
    template: require('./rsyncModal.component.pug'),
})
export class RsyncModalComponent implements OnInit {
    @Input() binary: RsyncBinary
    @Input() hostLabel = ''
    @Input() remotePath = ''
    /** The local folder remembered for a remote one — see `SidebarPlusRsyncService.suggestLocalFolder()`. */
    @Input() suggestLocal: (remotePath: string) => string|null = () => null

    direction: RsyncRequest['direction'] = 'upload'
    localPath = ''
    deleteExtra = false
    dryRun = false
    permissions: RsyncRequest['permissions'] = 'web'

    /** A field refreshed on every change rather than a getter: see piège #54. */
    commandPreview = ''

    /**
     * What the local field was last filled with automatically. While it still
     * holds exactly that, editing the remote folder may replace it; once the
     * user has typed or picked something, it is theirs and stays.
     */
    private autoFilledLocal = ''

    constructor (
        private modalInstance: NgbActiveModal,
        private rsync: SidebarPlusRsyncService,
        private i18n: SidebarPlusI18nService,
    ) { }

    ngOnInit (): void {
        this.suggestLocalPath()
        this.refreshPreview()
    }

    remotePathChanged (): void {
        if (this.localPath === this.autoFilledLocal) {
            this.suggestLocalPath()
        }
        this.refreshPreview()
    }

    private suggestLocalPath (): void {
        this.localPath = this.suggestLocal(this.remotePath.trim()) ?? ''
        this.autoFilledLocal = this.localPath
    }

    get request (): RsyncRequest {
        return {
            direction: this.direction,
            localPath: this.localPath.trim(),
            remotePath: this.remotePath.trim(),
            deleteExtra: this.deleteExtra,
            dryRun: this.dryRun,
            permissions: this.permissions,
        }
    }

    refreshPreview (): void {
        const request = this.request
        this.commandPreview = this.rsync.preview(this.binary, {
            ...request,
            localPath: request.localPath || '…',
        })
    }

    async pickLocalFolder (): Promise<void> {
        const remote = electronRemote()
        if (!remote) {
            return
        }
        const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
            title: this.i18n.t('Choose the local folder'),
            defaultPath: this.localPath || undefined,
            properties: ['openDirectory', 'createDirectory'],
        }).catch(() => null)
        if (result && !result.canceled && result.filePaths.length) {
            this.localPath = result.filePaths[0]
            this.refreshPreview()
        }
    }

    start (): void {
        const request = this.request
        if (!request.localPath || !request.remotePath) {
            return
        }
        this.modalInstance.close(request)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }
}
