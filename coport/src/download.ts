import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const TEMP_DIR = '/var/lib/vz/dump/coport-tmp'
const MAX_RETRIES = 3

export const tempPath = (name: string): string => join(TEMP_DIR, `${name}.vma.zst`)

export const ensureTempDir = (): Promise<void> =>
    mkdir(TEMP_DIR, { recursive: true }).then(() => {})

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export const downloadWithRetry = async (
    url: string,
    destPath: string,
    onProgress?: (pct: number) => void
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
    onProgress?: (pct: number) => void
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
        if (total > 0 && onProgress) {
            onProgress(Math.round((received / total) * 100))
        }
    }
    await writer.end()
}

export const verifySha256 = async (filePath: string, expected: string): Promise<void> => {
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
