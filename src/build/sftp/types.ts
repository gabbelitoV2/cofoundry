export type TransferEvent = {
    direction: '↑' | '↓'
    doneBytes: number
    totalBytes: number
    doneFiles: number
    totalFiles: number
    currentFile: string
    startMs: number
}

export type OnProgress = (event: TransferEvent) => void
export type OnPhase = (phase: string) => void

export type LocalFile = {
    localPath: string
    relPath: string
    size: number
    mtimeMs: number
    mode: number
}

export type RemoteFile = {
    remotePath: string
    relPath: string
    size: number
    mtimeMs: number
}
