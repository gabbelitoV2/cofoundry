import prettyMs from 'pretty-ms'

export const fmtBytes = (n: number): string => {
    if (!Number.isFinite(n) || n < 0) return '0B'
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}MB`
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}KB`
    return `${Math.round(n)}B`
}

export const fmtElapsed = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return `${minutes}m${seconds}s`
}

export const fmtDuration = (ms: number): string =>
    prettyMs(ms, {
        compact: false,
        secondsDecimalDigits: 0,
        keepDecimalsOnWholeSeconds: false,
    })

export const fmtPercent = (n: number): string =>
    `${String(Math.max(0, Math.min(100, Math.round(n)))).padStart(3)}%`

export const fmtRate = (bytes: number, ms: number): string => {
    if (ms <= 0) return '0B/s'
    return `${fmtBytes(bytes / (ms / 1000))}/s`
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export type WgetProgress = { pct: number; speed?: string; eta?: string }

export const parseWgetLine = (raw: string): WgetProgress | null => {
    const line = raw.replace(ANSI_RE, '').replace(/\r/g, '').trim()
    if (!line) return null
    const pctMatch = line.match(/(\d+)%\[/)
    if (!pctMatch) return null
    const out: WgetProgress = { pct: parseInt(pctMatch[1]!, 10) }
    const speedMatch = line.match(/([\d.]+\s*[KMGT]?B\/s)/i)
    if (speedMatch) out.speed = speedMatch[1]!.replace(/\s+/, '')
    const etaMatch = line.match(/\beta\s+(.+)$/)
    if (etaMatch) out.eta = etaMatch[1]!.trim()
    return out
}

export const formatTransferStatus = (
    direction: '↑' | '↓',
    doneBytes: number,
    totalBytes: number,
    doneFiles: number,
    totalFiles: number,
    currentFile: string,
    startMs: number
): string => {
    const pct =
        totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 100
    const elapsedMs = Date.now() - startMs
    const speed = elapsedMs >= 100 ? doneBytes / (elapsedMs / 1000) : 0
    const name = currentFile.split('/').pop()?.slice(0, 32) ?? ''
    return [
        `${direction} ${String(pct).padStart(3)}%`,
        `${fmtBytes(doneBytes)}/${fmtBytes(totalBytes)}`,
        `${fmtBytes(speed)}/s`,
        `${doneFiles}/${totalFiles}`,
        fmtElapsed(elapsedMs),
        name,
    ].join('  ')
}

export const formatWgetStatus = (label: string, p: WgetProgress): string => {
    const pct = String(p.pct).padStart(3) + '%'
    const speed = p.speed ?? ''
    const eta = p.eta ? `eta ${p.eta}` : ''
    return `${label}  ${pct}  ${speed}  ${eta}`.trimEnd()
}
