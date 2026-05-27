import SftpClient from 'ssh2-sftp-client'
import { readdir, stat } from 'fs/promises'
import { createWriteStream, mkdirSync } from 'fs'
import { dirname, join, relative, posix } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { PassThrough } from 'stream'
import { finished } from 'stream/promises'
import pc from 'picocolors'

const isTTY = process.stderr.isTTY

// ── progress rendering ───────────────────────────────────────────────────────

const BAR_WIDTH = 28

function renderBar(pct: number): string {
    const filled = Math.round((pct / 100) * BAR_WIDTH)
    return (
        '[' +
        pc.cyan('█'.repeat(filled)) +
        pc.dim('░'.repeat(BAR_WIDTH - filled)) +
        ']'
    )
}

function fmtBytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}MB`
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}KB`
    return `${n}B`
}

const fmtElapsed = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`

    const totalSeconds = Math.round(ms / 1000)
    if (totalSeconds < 60) return `${totalSeconds}s`

    const minutes = Math.floor(totalSeconds / 60)
    const seconds = String(totalSeconds % 60).padStart(2, '0')
    return `${minutes}m${seconds}s`
}

type TransferProgress = {
    direction: '↑' | '↓'
    totalBytes: number
    totalFiles: number
    doneBytes: number
    doneFiles: number
    currentFile: string
    startMs: number
    lastRenderMs: number
    lastLoggedPct: number
    lastLoggedMs: number
}

const buildProgressLine = (progress: TransferProgress): string => {
    const pct =
        progress.totalBytes > 0
            ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
            : 100
    const elapsedMs = Date.now() - progress.startMs
    const speed = elapsedMs >= 100 ? progress.doneBytes / (elapsedMs / 1000) : 0
    const amount = `${fmtBytes(progress.doneBytes)}/${fmtBytes(progress.totalBytes)}`
    const name = progress.currentFile.split('/').pop()!.slice(0, 28)

    return [
        `${pc.cyan(progress.direction)} ${renderBar(pct)}`,
        `${String(pct).padStart(3)}%`,
        amount.padEnd(18),
        `${fmtBytes(speed)}/s`.padEnd(12),
        `${String(progress.doneFiles).padStart(String(progress.totalFiles).length)}/${progress.totalFiles}`,
        fmtElapsed(elapsedMs).padEnd(6),
        name,
    ].join('  ')
}

const writeProgress = (progress: TransferProgress, force = false): void => {
    const now = Date.now()
    const pct =
        progress.totalBytes > 0
            ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
            : 100
    let line = `  ${buildProgressLine(progress)}`

    if (isTTY) {
        if (!force && now - progress.lastRenderMs < 100) return
        progress.lastRenderMs = now
        const cols = process.stderr.columns || 80
        const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length
        if (visibleLen > cols - 1) {
            line = line.slice(0, line.lastIndexOf('  ')) // drop filename first
            const v2 = line.replace(/\x1b\[[0-9;]*m/g, '').length
            if (v2 > cols - 1) line = line.slice(0, cols - 1) // hard cap
        }
        process.stderr.write(`\r\x1b[K${line}`)
        return
    }

    const shouldLog =
        force ||
        pct >= progress.lastLoggedPct + 10 ||
        now - progress.lastLoggedMs >= 5000
    if (!shouldLog) return

    progress.lastLoggedPct = pct
    progress.lastLoggedMs = now
    process.stderr.write(`${line}\n`)
}

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

async function connect(target: string): Promise<SftpClient> {
    const { user, host, port } = parseTarget(target)
    const cfg: Record<string, unknown> = { host, port, username: user }

    if (process.env.SSH_AUTH_SOCK) {
        cfg.agent = process.env.SSH_AUTH_SOCK
    } else {
        const keyFile = DEFAULT_KEYS.find(existsSync)
        if (keyFile) {
            const { readFile } = await import('fs/promises')
            cfg.privateKey = await readFile(keyFile)
        }
    }

    const client = new SftpClient()
    await client.connect(cfg as Parameters<SftpClient['connect']>[0])
    return client
}

// ── local directory walk ─────────────────────────────────────────────────────

interface LocalFile {
    localPath: string
    relPath: string // always forward-slash, relative to upload root
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

function matchesExclude(relPath: string, excludes: string[]): boolean {
    // Match any path component exactly (mirrors rsync --exclude=name behavior)
    const parts = relPath.split('/')
    return excludes.some(ex => parts.some(p => p === ex))
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
            results.push({ remotePath, relPath, size: entry.size, mtimeMs: entry.modifyTime })
        }
    }
    return results
}

// Preserve local mtime on the remote file so future runs can diff by mtime+size.
// ssh2-sftp-client doesn't expose setstat publicly; reach into the underlying
// ssh2 sftp stream. mtime is in seconds (Unix timestamp) per the SFTP spec.
function setRemoteMtime(client: SftpClient, remotePath: string, mtimeMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const mtime = Math.floor(mtimeMs / 1000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(client as any).sftp.setstat(remotePath, { mtime, atime: mtime }, (err: Error | null) => {
            if (err) reject(err)
            else resolve()
        })
    })
}

// ── upload ───────────────────────────────────────────────────────────────────

export async function sftpUpload(
    target: string,
    localDir: string,
    remoteDir: string,
    opts: { excludes?: string[]; delete?: boolean; concurrency?: number } = {}
): Promise<void> {
    const excludes = opts.excludes ?? []
    const concurrency = opts.concurrency ?? 4

    // One setup connection: mkdir, diff against remote, prune, pre-create dirs.
    const [files, setupClient] = await Promise.all([
        walkLocal(localDir, localDir, excludes),
        connect(target),
    ])

    await setupClient.mkdir(remoteDir, true)
    const remoteFiles = await walkRemote(setupClient, remoteDir, remoteDir).catch(
        () => [] as RemoteFile[]
    )

    if (opts.delete) {
        const localRels = new Set(files.map(f => f.relPath))
        await pruneRemote(setupClient, remoteDir, remoteDir, localRels, excludes)
    }

    // Pre-create all subdirectories so parallel workers don't race on mkdir.
    const neededDirs = new Set<string>()
    for (const file of files) {
        const parent = posix.dirname(posix.join(remoteDir, file.relPath))
        if (parent !== remoteDir) neededDirs.add(parent)
    }
    for (const dir of neededDirs) {
        await setupClient.mkdir(dir, true)
    }

    await setupClient.end()

    // Skip files where remote size AND mtime (truncated to seconds) both match.
    // mtime is preserved on upload so this is equivalent to rsync's default behaviour.
    const remoteMap = new Map(remoteFiles.map(f => [f.relPath, f]))
    const toUpload = files.filter(f => {
        const r = remoteMap.get(f.relPath)
        return !r || r.size !== f.size || Math.floor(r.mtimeMs / 1000) !== Math.floor(f.mtimeMs / 1000)
    })

    if (toUpload.length === 0) {
        if (isTTY) process.stderr.write('\r\x1b[K')
        return
    }

    const fileBytes = new Array<number>(toUpload.length).fill(0)
    const progress: TransferProgress = {
        direction: '↑',
        totalBytes: toUpload.reduce((s, f) => s + f.size, 0),
        totalFiles: toUpload.length,
        doneBytes: 0,
        doneFiles: 0,
        currentFile: toUpload[0]!.relPath,
        startMs: Date.now(),
        lastRenderMs: 0,
        lastLoggedPct: -10,
        lastLoggedMs: 0,
    }

    writeProgress(progress, true)

    const uploadFile = async (client: SftpClient, idx: number): Promise<void> => {
        const file = toUpload[idx]!
        const remotePath = posix.join(remoteDir, file.relPath)

        await client.fastPut(file.localPath, remotePath, {
            step: (transferred: number) => {
                fileBytes[idx] = transferred
                progress.doneBytes = fileBytes.reduce((a, b) => a + b, 0)
                progress.currentFile = file.relPath
                writeProgress(progress)
            },
        })
        await client.chmod(remotePath, file.mode & 0o7777)
        await setRemoteMtime(client, remotePath, file.mtimeMs)

        fileBytes[idx] = file.size
        progress.doneBytes = fileBytes.reduce((a, b) => a + b, 0)
        progress.doneFiles++
        writeProgress(progress, true)
    }

    const poolSize = Math.min(concurrency, toUpload.length)
    const clients = await Promise.all(
        Array.from({ length: poolSize }, () => connect(target))
    )

    try {
        let next = 0
        await Promise.all(
            clients.map(async client => {
                while (next < toUpload.length) {
                    await uploadFile(client, next++)
                }
            })
        )
    } finally {
        await Promise.all(clients.map(c => c.end().catch(() => {})))
    }

    if (isTTY) process.stderr.write('\n')
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
    concurrency = 4
): Promise<void> {
    mkdirSync(localDir, { recursive: true })

    // Use one connection just for the directory listing, then close it.
    const lister = await connect(target)
    const files = await walkRemote(lister, remoteDir, remoteDir).finally(() =>
        lister.end()
    )

    if (files.length === 0) return

    // Per-file byte counters; index matches files[]. JS is single-threaded so
    // concurrent async callbacks updating these are safe without a mutex.
    const fileBytes = new Array<number>(files.length).fill(0)

    const progress: TransferProgress = {
        direction: '↓',
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        totalFiles: files.length,
        doneBytes: 0,
        doneFiles: 0,
        currentFile: files[0]!.relPath,
        startMs: Date.now(),
        lastRenderMs: 0,
        lastLoggedPct: -10,
        lastLoggedMs: 0,
    }

    writeProgress(progress, true)

    const downloadFile = async (client: SftpClient, idx: number): Promise<void> => {
        const file = files[idx]!
        const localPath = join(localDir, file.relPath)
        mkdirSync(dirname(localPath), { recursive: true })

        const fileStream = createWriteStream(localPath)
        const meter = new PassThrough()
        const fileDone = finished(fileStream)

        meter.on('data', (chunk: Buffer) => {
            fileBytes[idx] = (fileBytes[idx] ?? 0) + chunk.length
            progress.doneBytes = fileBytes.reduce((a, b) => a + b, 0)
            progress.currentFile = file.relPath
            writeProgress(progress)
        })

        meter.pipe(fileStream)

        try {
            await client.get(file.remotePath, meter)
            await fileDone
        } catch (err) {
            meter.destroy()
            fileStream.destroy()
            throw err
        }

        // Normalize to exact size in case of any chunk-counting drift
        fileBytes[idx] = file.size
        progress.doneBytes = fileBytes.reduce((a, b) => a + b, 0)
        progress.doneFiles++
        writeProgress(progress, true)
    }

    // Open a pool of connections, then fan out files across workers
    const poolSize = Math.min(concurrency, files.length)
    const clients = await Promise.all(
        Array.from({ length: poolSize }, () => connect(target))
    )

    try {
        let next = 0
        await Promise.all(
            clients.map(async client => {
                while (next < files.length) {
                    await downloadFile(client, next++)
                }
            })
        )
    } finally {
        await Promise.all(clients.map(c => c.end().catch(() => {})))
    }

    if (isTTY) process.stderr.write('\n')
}
