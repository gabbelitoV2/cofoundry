import { posix } from 'node:path'
import type SftpClient from 'ssh2-sftp-client'
import { connectSftp, withSftpPool } from '@/build/sftp/connection.ts'
import { createTransferProgress } from '@/build/sftp/progress.ts'
import { pruneRemote, walkLocal, walkRemote } from '@/build/sftp/walk.ts'
import type { OnPhase, OnProgress } from '@/build/sftp/types.ts'

export type SftpUploadOptions = {
    excludes?: string[]
    delete?: boolean
    concurrency?: number
    onProgress?: OnProgress
    onPhase?: OnPhase
}

const setRemoteStat = (
    client: SftpClient,
    remotePath: string,
    mode: number,
    mtimeMs: number
): Promise<void> =>
    new Promise((resolve, reject) => {
        const mtime = Math.floor(mtimeMs / 1000)
        const rawClient = client as unknown as {
            sftp: {
                setstat: (
                    path: string,
                    attrs: Record<string, number>,
                    callback: (error: Error | null) => void
                ) => void
            }
        }
        rawClient.sftp.setstat(
            remotePath,
            { mode: mode & 0o7777, mtime, atime: mtime },
            error => (error ? reject(error) : resolve())
        )
    })

export const sftpUpload = async (
    target: string,
    localDir: string,
    remoteDir: string,
    opts: SftpUploadOptions = {}
): Promise<void> => {
    const excludes = opts.excludes ?? []
    const concurrency = opts.concurrency ?? 4
    const phase = opts.onPhase ?? (() => {})

    phase('scanning local files')
    const [files, setupClient] = await Promise.all([
        walkLocal(localDir, localDir, excludes),
        connectSftp(target),
    ])
    try {
        phase(`scanning remote (${files.length} local files)`)
        await setupClient.mkdir(remoteDir, true)
        const remoteFiles = await walkRemote(
            setupClient,
            remoteDir,
            remoteDir
        ).catch(() => [])

        if (opts.delete) {
            phase('pruning stale remote files')
            await pruneRemote(
                setupClient,
                remoteDir,
                remoteDir,
                new Set(files.map(file => file.relPath)),
                excludes
            )
        }

        phase('preparing directories')
        const directories = new Set(
            files
                .map(file => posix.dirname(posix.join(remoteDir, file.relPath)))
                .filter(directory => directory !== remoteDir)
        )
        for (const directory of directories)
            await setupClient.mkdir(directory, true)

        const remoteMap = new Map(remoteFiles.map(file => [file.relPath, file]))
        const pending = files.filter(file => {
            const remote = remoteMap.get(file.relPath)
            return (
                !remote ||
                remote.size !== file.size ||
                Math.floor(remote.mtimeMs / 1000) !==
                    Math.floor(file.mtimeMs / 1000)
            )
        })
        if (pending.length === 0) {
            phase('already in sync')
            return
        }
        phase(
            `uploading ${pending.length} file${pending.length === 1 ? '' : 's'}`
        )

        const progress = createTransferProgress('↑', pending, opts.onProgress)
        progress.emit()
        await setupClient.end()

        await withSftpPool(
            target,
            Math.min(concurrency, pending.length),
            async (clients, queue) => {
                const jobs = pending.map((file, index) => {
                    const client = clients[index % clients.length]!
                    return queue.add(async () => {
                        const remotePath = posix.join(remoteDir, file.relPath)
                        await client.fastPut(file.localPath, remotePath, {
                            step: transferred =>
                                progress.update(index, transferred),
                        })
                        await setRemoteStat(
                            client,
                            remotePath,
                            file.mode,
                            file.mtimeMs
                        )
                        progress.update(index, file.size, true)
                    })
                })
                await Promise.all(jobs)
            }
        )
    } finally {
        await setupClient.end().catch(() => {})
    }
}
