import { mkdirSync } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { connectSftp, withSftpPool } from '@/build/sftp/connection.ts'
import { createTransferProgress } from '@/build/sftp/progress.ts'
import type { OnProgress } from '@/build/sftp/types.ts'
import { walkRemote } from '@/build/sftp/walk.ts'

export const sftpDownload = async (
    target: string,
    remoteDir: string,
    localDir: string,
    opts: { concurrency?: number; onProgress?: OnProgress } = {}
): Promise<void> => {
    mkdirSync(localDir, { recursive: true })
    const lister = await connectSftp(target)
    const files = await walkRemote(lister, remoteDir, remoteDir).finally(() =>
        lister.end()
    )
    if (files.length === 0) return

    const progress = createTransferProgress('↓', files, opts.onProgress)
    progress.emit()
    await withSftpPool(
        target,
        Math.min(opts.concurrency ?? 4, files.length),
        async (clients, queue) => {
            const jobs = files.map((file, index) => {
                const client = clients[index % clients.length]!
                return queue.add(async () => {
                    const localPath = join(localDir, file.relPath)
                    const tmpPath = `${localPath}.tmp`
                    mkdirSync(dirname(localPath), { recursive: true })
                    try {
                        await client.fastGet(file.remotePath, tmpPath, {
                            concurrency: 16,
                            chunkSize: 256 * 1024,
                            step: transferred =>
                                progress.update(index, transferred),
                        })
                        await rename(tmpPath, localPath)
                    } catch (error) {
                        await unlink(tmpPath).catch(() => {})
                        throw error
                    }
                    progress.update(index, file.size, true)
                })
            })
            await Promise.all(jobs)
        }
    )
}
