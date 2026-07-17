import SftpClient from 'ssh2-sftp-client'
import { readdir, stat, rename, unlink } from 'fs/promises'
import { mkdirSync } from 'fs'
import { dirname, join, relative, posix } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import PQueue from 'p-queue'
import pRetry from 'p-retry'

export type TransferEvent = {
    direction: '↑' | '↓'
    doneBytes: number
    totalBytes: number
    doneFiles: number
    totalFiles: number
    currentFile: string
    startMs: number
}

export type OnProgress = (ev: TransferEvent) => void
export type OnPhase = (phase: string) => void

// ── SSH connection ───────────────────────────────────────────────────────────

function parseTarget(target: string): {
    user: string
    host: string
    port: number
} {
    const at = target.lastIndexOf('@')
    if (at === -1)
        throw new Error(`Invalid SSH_TARGET "${target}": expected user@host`)
    const user = target.slice(0, at)
    const hostPart = target.slice(at + 1)
    const colon = hostPart.lastIndexOf(':')
    return colon === -1
        ? { user, host: hostPart, port: 22 }
        : {
              user,
              host: hostPart.slice(0, colon),
              port: parseInt(hostPart.slice(colon + 1)),
          }
}

const DEFAULT_KEYS = ['id_ed25519', 'id_rsa', 'id_ecdsa'].map(k =>
    join(homedir(), '.ssh', k)
)

const doConnect = async (target: string): Promise<SftpClient> => {
    const { user, host, port } = parseTarget(target)
    const cfg: Record<string, unknown> = { host, port, username: user }

    if (process.env.SSH_AUTH_SOCK) {
        cfg.agent = process.env.SSH_AUTH_SOCK
    } else {
        const keyFile = DEFAULT_KEYS.find(existsSync)
        if (keyFile) {
            const { readFile } = await import('fs/promises')
            cfg.privateKey = await readFile(keyFile)
        } else {
            // No key and no agent — attempt "none" auth. The server may accept
            // it (e.g. Tailscale SSH, which authenticates via tailnet identity
            // and ignores the SSH-level credential). If the server refuses,
            // ssh2 surfaces a clearer permission error than failing upfront.
            cfg.authHandler = ['none']
        }
    }

    const client = new SftpClient()
    await client.connect(cfg as Parameters<SftpClient['connect']>[0])
    return client
}

const connect = (target: string): Promise<SftpClient> =>
    pRetry(() => doConnect(target), { retries: 3, minTimeout: 500, factor: 2 })

// ── directory walks ──────────────────────────────────────────────────────────

interface LocalFile {
    localPath: string
    relPath: string
    size: number
    mtimeMs: number
    mode: number
}

interface RemoteFile {
    remotePath: string
    relPath: string
    size: number
    mtimeMs: number
}

export const matchesExclude = (
    relPath: string,
    excludes: string[]
): boolean => {
    const parts = relPath.split('/')
    return excludes.some(ex => {
        if (ex.startsWith('*.')) return relPath.endsWith(ex.slice(1))
        if (ex.includes('/'))
            return relPath === ex || relPath.startsWith(`${ex}/`)
        return parts.some(p => p === ex)
    })
}

async function walkLocal(
    dir: string,
    base: string,
    excludes: string[]
): Promise<LocalFile[]> {
    const results: LocalFile[] = []
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const full = join(dir, entry.name)
        const rel = relative(base, full).replace(/\\/g, '/')
        if (matchesExclude(rel, excludes)) continue
        if (entry.isDirectory()) {
            results.push(...(await walkLocal(full, base, excludes)))
        } else if (entry.isFile()) {
            const s = await stat(full)
            results.push({
                localPath: full,
                relPath: rel,
                size: s.size,
                mtimeMs: s.mtimeMs,
                mode: s.mode,
            })
        }
    }
    return results
}

const walkRemote = async (
    client: SftpClient,
    dir: string,
    base: string
): Promise<RemoteFile[]> => {
    const results: RemoteFile[] = []
    const entries = await client.list(dir)
    for (const entry of entries) {
        const remotePath = posix.join(dir, entry.name)
        const relPath = posix.relative(base, remotePath)
        if (entry.type === 'd') {
            results.push(...(await walkRemote(client, remotePath, base)))
        } else {
            results.push({
                remotePath,
                relPath,
                size: entry.size,
                mtimeMs: entry.modifyTime,
            })
        }
    }
    return results
}

// Preserve local mode + mtime on remote so future runs can diff by mtime+size.
// ssh2-sftp-client doesn't expose setstat publicly; reach into the underlying
// ssh2 sftp stream. mtime is in seconds (Unix timestamp) per the SFTP spec.
// One setstat call carries both mode and mtime, saving a round-trip per file.
function setRemoteStat(
    client: SftpClient,
    remotePath: string,
    mode: number,
    mtimeMs: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        const mtime = Math.floor(mtimeMs / 1000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(client as any).sftp.setstat(
            remotePath,
            { mode: mode & 0o7777, mtime, atime: mtime },
            (err: Error | null) => {
                if (err) reject(err)
                else resolve()
            }
        )
    })
}

// ── connection pool ──────────────────────────────────────────────────────────

const withPool = async <T>(
    target: string,
    size: number,
    body: (clients: SftpClient[], queue: PQueue) => Promise<T>
): Promise<T> => {
    const clients = await Promise.all(
        Array.from({ length: size }, () => connect(target))
    )
    const queue = new PQueue({ concurrency: size })
    try {
        return await body(clients, queue)
    } finally {
        await Promise.all(clients.map(c => c.end().catch(() => {})))
    }
}

// ── upload ───────────────────────────────────────────────────────────────────

export async function sftpUpload(
    target: string,
    localDir: string,
    remoteDir: string,
    opts: {
        excludes?: string[]
        delete?: boolean
        concurrency?: number
        onProgress?: OnProgress
        onPhase?: OnPhase
    } = {}
): Promise<void> {
    const excludes = opts.excludes ?? []
    const concurrency = opts.concurrency ?? 4
    const phase = opts.onPhase ?? (() => {})

    phase('scanning local files')
    const [files, setupClient] = await Promise.all([
        walkLocal(localDir, localDir, excludes),
        connect(target),
    ])

    phase(`scanning remote (${files.length} local files)`)
    await setupClient.mkdir(remoteDir, true)
    const remoteFiles = await walkRemote(
        setupClient,
        remoteDir,
        remoteDir
    ).catch(() => [] as RemoteFile[])

    if (opts.delete) {
        phase('pruning stale remote files')
        const localRels = new Set(files.map(f => f.relPath))
        await pruneRemote(
            setupClient,
            remoteDir,
            remoteDir,
            localRels,
            excludes
        )
    }

    phase('preparing directories')
    const neededDirs = new Set<string>()
    for (const file of files) {
        const parent = posix.dirname(posix.join(remoteDir, file.relPath))
        if (parent !== remoteDir) neededDirs.add(parent)
    }
    for (const dir of neededDirs) {
        await setupClient.mkdir(dir, true)
    }

    await setupClient.end()

    // Skip files where remote size AND mtime (truncated to seconds) match.
    const remoteMap = new Map(remoteFiles.map(f => [f.relPath, f]))
    const toUpload = files.filter(f => {
        const r = remoteMap.get(f.relPath)
        return (
            !r ||
            r.size !== f.size ||
            Math.floor(r.mtimeMs / 1000) !== Math.floor(f.mtimeMs / 1000)
        )
    })

    if (toUpload.length === 0) {
        phase('already in sync')
        return
    }

    phase(
        `uploading ${toUpload.length} file${toUpload.length === 1 ? '' : 's'}`
    )

    const fileBytes = new Array<number>(toUpload.length).fill(0)
    const totalBytes = toUpload.reduce((s, f) => s + f.size, 0)
    const startMs = Date.now()
    let doneFiles = 0
    let currentFile = toUpload[0]!.relPath

    const emit = (): void => {
        opts.onProgress?.({
            direction: '↑',
            doneBytes: fileBytes.reduce((a, b) => a + b, 0),
            totalBytes,
            doneFiles,
            totalFiles: toUpload.length,
            currentFile,
            startMs,
        })
    }

    emit()

    const poolSize = Math.min(concurrency, toUpload.length)
    await withPool(target, poolSize, async (clients, queue) => {
        toUpload.forEach((file, idx) => {
            const client = clients[idx % clients.length]!
            queue.add(async () => {
                const remotePath = posix.join(remoteDir, file.relPath)
                await client.fastPut(file.localPath, remotePath, {
                    step: (transferred: number) => {
                        fileBytes[idx] = transferred
                        currentFile = file.relPath
                        emit()
                    },
                })
                await setRemoteStat(client, remotePath, file.mode, file.mtimeMs)
                fileBytes[idx] = file.size
                doneFiles++
                emit()
            })
        })
        await queue.onIdle()
    })
}

async function pruneRemote(
    client: SftpClient,
    remoteBase: string,
    remoteDir: string,
    keep: Set<string>,
    excludes: string[]
): Promise<void> {
    let entries: Awaited<ReturnType<SftpClient['list']>>
    try {
        entries = await client.list(remoteDir)
    } catch {
        return
    }
    for (const entry of entries) {
        const remotePath = posix.join(remoteDir, entry.name)
        const relPath = posix.relative(remoteBase, remotePath)
        if (matchesExclude(relPath, excludes)) continue
        if (entry.type === 'd') {
            await pruneRemote(client, remoteBase, remotePath, keep, excludes)
        } else if (!keep.has(relPath)) {
            await client.delete(remotePath).catch(() => {})
        }
    }
}

// ── download ─────────────────────────────────────────────────────────────────

export async function sftpDownload(
    target: string,
    remoteDir: string,
    localDir: string,
    opts: { concurrency?: number; onProgress?: OnProgress } = {}
): Promise<void> {
    const concurrency = opts.concurrency ?? 4
    mkdirSync(localDir, { recursive: true })

    const lister = await connect(target)
    const files = await walkRemote(lister, remoteDir, remoteDir).finally(() =>
        lister.end()
    )

    if (files.length === 0) return

    const fileBytes = new Array<number>(files.length).fill(0)
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    const startMs = Date.now()
    let doneFiles = 0
    let currentFile = files[0]!.relPath

    const emit = (): void => {
        opts.onProgress?.({
            direction: '↓',
            doneBytes: fileBytes.reduce((a, b) => a + b, 0),
            totalBytes,
            doneFiles,
            totalFiles: files.length,
            currentFile,
            startMs,
        })
    }

    emit()

    const poolSize = Math.min(concurrency, files.length)
    await withPool(target, poolSize, async (clients, queue) => {
        files.forEach((file, idx) => {
            const client = clients[idx % clients.length]!
            queue.add(async () => {
                const localPath = join(localDir, file.relPath)
                // Write to a sibling .tmp path and rename on completion so an
                // interrupted download never leaves a truncated artifact at
                // the final filename. Rename is atomic on the same filesystem.
                const tmpPath = `${localPath}.tmp`
                mkdirSync(dirname(localPath), { recursive: true })

                try {
                    await client.fastGet(file.remotePath, tmpPath, {
                        concurrency: 16,
                        chunkSize: 256 * 1024,
                        step: (transferred: number) => {
                            fileBytes[idx] = transferred
                            currentFile = file.relPath
                            emit()
                        },
                    })
                    await rename(tmpPath, localPath)
                } catch (err) {
                    await unlink(tmpPath).catch(() => {})
                    throw err
                }

                fileBytes[idx] = file.size
                doneFiles++
                emit()
            })
        })
        await queue.onIdle()
    })
}
