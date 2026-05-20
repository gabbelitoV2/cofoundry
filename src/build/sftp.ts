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

type DownloadProgress = {
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

const buildDownloadProgressLine = (progress: DownloadProgress): string => {
    const pct =
        progress.totalBytes > 0
            ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
            : 100
    const elapsedMs = Date.now() - progress.startMs
    const speed = elapsedMs >= 100 ? progress.doneBytes / (elapsedMs / 1000) : 0
    const amount = `${fmtBytes(progress.doneBytes)}/${fmtBytes(progress.totalBytes)}`
    const name = progress.currentFile.split('/').pop()!.slice(0, 28)

    return [
        `${pc.cyan('↓')} ${renderBar(pct)}`,
        `${String(pct).padStart(3)}%`,
        amount.padEnd(18),
        `${fmtBytes(speed)}/s`.padEnd(12),
        `${String(progress.doneFiles).padStart(String(progress.totalFiles).length)}/${progress.totalFiles}`,
        fmtElapsed(elapsedMs).padEnd(6),
        name,
    ].join('  ')
}

const writeDownloadProgress = (
    progress: DownloadProgress,
    force = false
): void => {
    const now = Date.now()
    const pct =
        progress.totalBytes > 0
            ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
            : 100
    const line = `  ${buildDownloadProgressLine(progress)}`

    if (isTTY) {
        if (!force && now - progress.lastRenderMs < 100) return
        progress.lastRenderMs = now
        process.stderr.write(`\r${line}`)
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
    mode: number
}

interface RemoteFile {
    remotePath: string
    relPath: string
    size: number
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
            results.push({ remotePath, relPath, size: entry.size })
        }
    }
    return results
}

// ── upload ───────────────────────────────────────────────────────────────────

export async function sftpUpload(
    target: string,
    localDir: string,
    remoteDir: string,
    opts: { excludes?: string[]; delete?: boolean } = {}
): Promise<void> {
    const excludes = opts.excludes ?? []
    const files = await walkLocal(localDir, localDir, excludes)
    const totalBytes = files.reduce((s, f) => s + f.size, 0)

    const client = await connect(target)
    try {
        await client.mkdir(remoteDir, true)

        let doneBytes = 0
        const startMs = Date.now()
        const madeDir = new Set<string>()

        const renderProgress = isTTY
            ? (relPath: string) => {
                  const pct =
                      totalBytes > 0
                          ? Math.round((doneBytes / totalBytes) * 100)
                          : 100
                  const elapsed = (Date.now() - startMs) / 1000
                  const speed = elapsed > 0.1 ? doneBytes / elapsed : 0
                  const name = relPath.split('/').pop()!.slice(0, 22)
                  process.stderr.write(
                      `\r  ${renderBar(pct)} ${String(pct).padStart(3)}%  ${(fmtBytes(speed) + '/s').padEnd(12)}  ${name}`
                  )
              }
            : () => {}

        for (const file of files) {
            const remotePath = posix.join(remoteDir, file.relPath)
            const remoteParent = posix.dirname(remotePath)
            if (!madeDir.has(remoteParent)) {
                await client.mkdir(remoteParent, true)
                madeDir.add(remoteParent)
            }

            const fileStart = doneBytes
            await client.fastPut(file.localPath, remotePath, {
                step: (transferred: number) => {
                    doneBytes = fileStart + transferred
                    renderProgress(file.relPath)
                },
            })
            await client.chmod(remotePath, file.mode & 0o7777)
            doneBytes = fileStart + file.size
        }

        if (opts.delete) {
            const localRels = new Set(files.map(f => f.relPath))
            await pruneRemote(client, remoteDir, remoteDir, localRels, excludes)
        }

        if (isTTY) process.stderr.write('\r\x1b[K')
    } finally {
        await client.end()
    }
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
    localDir: string
): Promise<void> {
    mkdirSync(localDir, { recursive: true })

    const client = await connect(target)
    try {
        const files = await walkRemote(client, remoteDir, remoteDir)
        const progress: DownloadProgress = {
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            totalFiles: files.length,
            doneBytes: 0,
            doneFiles: 0,
            currentFile: files[0]?.relPath ?? '.',
            startMs: Date.now(),
            lastRenderMs: 0,
            lastLoggedPct: -10,
            lastLoggedMs: 0,
        }

        writeDownloadProgress(progress, true)

        for (const file of files) {
            const localPath = join(localDir, file.relPath)
            mkdirSync(dirname(localPath), { recursive: true })

            const fileStream = createWriteStream(localPath)
            const meter = new PassThrough()
            const fileDone = finished(fileStream)
            const fileStart = progress.doneBytes
            let transferred = 0

            progress.currentFile = file.relPath
            meter.on('data', chunk => {
                transferred += chunk.length
                progress.currentFile = file.relPath
                progress.doneBytes = fileStart + transferred
                writeDownloadProgress(progress)
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

            progress.currentFile = file.relPath
            progress.doneBytes = fileStart + file.size
            progress.doneFiles++
            writeDownloadProgress(progress, true)
        }

        if (isTTY) process.stderr.write('\n')
    } finally {
        await client.end()
    }
}
