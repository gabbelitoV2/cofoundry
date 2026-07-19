import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { connectSftp } from '@/build/sftp/connection.ts'
import { createTransferProgress } from '@/build/sftp/progress.ts'
import type { OnProgress } from '@/build/sftp/types.ts'

export const sftpUploadFile = async (
    target: string,
    localPath: string,
    remotePath: string,
    onProgress?: OnProgress
): Promise<void> => {
    const info = await stat(localPath)
    const file = { relPath: basename(localPath), size: info.size }
    const progress = createTransferProgress('↑', [file], onProgress)
    const client = await connectSftp(target)
    try {
        progress.emit()
        await client.fastPut(localPath, remotePath, {
            step: transferred => progress.update(0, transferred),
        })
        progress.update(0, info.size, true)
    } finally {
        await client.end().catch(() => {})
    }
}
