import type { OnProgress, TransferEvent } from '@/build/sftp/types.ts'

type ProgressFile = { relPath: string; size: number }

export type TransferProgress = {
    update: (index: number, transferred: number, completed?: boolean) => void
    emit: () => void
}

export const createTransferProgress = (
    direction: TransferEvent['direction'],
    files: ProgressFile[],
    onProgress?: OnProgress
): TransferProgress => {
    const fileBytes = new Array<number>(files.length).fill(0)
    const completed = new Set<number>()
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const startMs = Date.now()
    let currentIndex = 0

    const emit = (): void => {
        onProgress?.({
            direction,
            doneBytes: fileBytes.reduce((sum, bytes) => sum + bytes, 0),
            totalBytes,
            doneFiles: completed.size,
            totalFiles: files.length,
            currentFile: files[currentIndex]?.relPath ?? '',
            startMs,
        })
    }
    const update = (index: number, transferred: number, done = false): void => {
        currentIndex = index
        fileBytes[index] = transferred
        if (done) completed.add(index)
        emit()
    }
    return { update, emit }
}
