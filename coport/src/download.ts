import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const TEMP_DIR = '/var/lib/vz/dump/coport-tmp'
const MAX_RETRIES = 3

export interface DownloadProgress {
    pct: number
    received: number
    total: number
}

export const tempPath = (vmid: number): string =>
    join(TEMP_DIR, `vzdump-qemu-${vmid}-1970_01_01-00_00_00.vma.zst`)

export const ensureTempDir = (): Promise<void> =>
    mkdir(TEMP_DIR, { recursive: true }).then(() => {})

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export const downloadWithRetry = async (
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await download(url, destPath, onProgress)
            return
        } catch (err) {
            if (attempt === MAX_RETRIES) throw err
            await sleep(1000 * 2 ** (attempt - 1))
        }
    }
}

const download = async (
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
): Promise<void> => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)

    const total = Number(res.headers.get('content-length') ?? 0)
    const file = Bun.file(destPath)
    const writer = file.writer()

    let received = 0
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        writer.write(chunk)
        received += chunk.byteLength
        if (onProgress) {
            onProgress({
                pct: total > 0 ? Math.round((received / total) * 100) : 0,
                received,
                total,
            })
        }
    }
    await writer.end()
}

export const verifySha256 = async (
    filePath: string,
    expected: string
): Promise<void> => {
    const hash = createHash('sha256')
    const stream = Bun.file(filePath).stream()
    for await (const chunk of stream) {
        hash.update(chunk)
    }
    const actual = hash.digest('hex')
    if (actual !== expected) {
        throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`)
    }
}
