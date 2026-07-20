import { gunzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote } from '@/util.ts'
import { captureRemote } from '@/build/remote.ts'

export interface FrameAnalysis {
    width: number
    height: number
    /** Share of sampled pixels holding the single most common colour. */
    uniformFraction: number
    /** `#rrggbb` of that colour. */
    dominantColor: string
}

/** Cap on sampled pixels; a 1080p frame is 2M, and the ratio converges long before that. */
const MAX_SAMPLES = 200_000

const hex = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`

/**
 * Parse a binary PPM (P6). QEMU's `screendump` writes this format on every
 * build of pve-qemu, unlike PNG which needs libpng — see the same probe in
 * build/diagnostics/recorder.ts.
 *
 * The header is whitespace-delimited and may carry `#` comments between fields,
 * so it is scanned token by token rather than matched as a fixed shape.
 */
export const analyzeFrame = (buf: Buffer): FrameAnalysis => {
    if (buf.subarray(0, 2).toString('ascii') !== 'P6')
        throw new Error('not a binary PPM (P6) frame')

    const fields: number[] = []
    let i = 2
    while (fields.length < 3 && i < buf.length) {
        const ch = buf[i]!
        if (ch === 0x23) {
            while (i < buf.length && buf[i] !== 0x0a) i++
            continue
        }
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
            i++
            continue
        }
        let token = ''
        while (i < buf.length && buf[i]! > 0x20)
            token += String.fromCharCode(buf[i++]!)
        const value = Number.parseInt(token, 10)
        if (!Number.isInteger(value))
            throw new Error(`bad PPM header token: ${token}`)
        fields.push(value)
    }
    const [width, height, maxval] = fields
    if (!width || !height || !maxval) throw new Error('truncated PPM header')
    if (maxval !== 255) throw new Error(`unsupported PPM maxval: ${maxval}`)
    i++ // single whitespace byte terminating the header

    const pixels = width * height
    const stride = Math.max(1, Math.ceil(pixels / MAX_SAMPLES))
    const counts = new Map<number, number>()
    let sampled = 0
    for (let p = 0; p < pixels; p += stride) {
        const o = i + p * 3
        if (o + 2 >= buf.length) break
        const key = (buf[o]! << 16) | (buf[o + 1]! << 8) | buf[o + 2]!
        counts.set(key, (counts.get(key) ?? 0) + 1)
        sampled++
    }
    if (sampled === 0) throw new Error('PPM body is empty')

    let topKey = 0
    let topCount = 0
    for (const [key, count] of counts) {
        if (count > topCount) {
            topKey = key
            topCount = count
        }
    }
    return {
        width,
        height,
        uniformFraction: topCount / sampled,
        dominantColor: hex(
            (topKey >> 16) & 0xff,
            (topKey >> 8) & 0xff,
            topKey & 0xff
        ),
    }
}

const CAPTURE_SENTINEL = 'CF_NO_FRAME'

export const captureFrameScript = (
    vmid: number,
    remoteTmp: string,
    label: string
): string => `set -e
d=${shellQuote(`${remoteTmp}/frames`)}
mkdir -p "$d"
f="$d/${label}.ppm"
rm -f "$f" "$f.gz"
# Wake the display first. Both guests blank their console on an idle timer
# (Linux consoleblank defaults to 600s; Windows power plans turn the monitor
# off), and a blanked framebuffer is indistinguishable from a desktop that
# never painted — measured on a live VM, where a blank frame gzipped to 3 KB
# and the same console after this keypress gzipped to 816 KB.
#
# A bare modifier is the safe way to do it: it wakes DPMS without typing a
# character, dismissing a dialog, or triggering a shortcut in the guest.
echo "sendkey shift" | timeout 15 qm monitor ${vmid} >/dev/null 2>&1 || true
sleep 3
echo "screendump $f" | timeout 20 qm monitor ${vmid} >/dev/null 2>&1 || true
if [ ! -s "$f" ]; then echo ${CAPTURE_SENTINEL}; exit 0; fi
gzip -f "$f"
base64 -w0 "$f.gz"
rm -f "$f.gz"`

export interface CapturedFrame {
    analysis: FrameAnalysis
    /** Gzipped PPM, as pulled off the node. */
    gzipped: Buffer
}

/**
 * Screendump the emulated framebuffer once. This needs nothing from the guest —
 * no agent, no session — which is what makes it the only check that can see a
 * kernel panic, a GRUB hang, or a desktop that never painted.
 */
export const captureFrame = async (
    target: string,
    vmid: number,
    remoteTmp: string,
    label: string
): Promise<CapturedFrame | null> => {
    const raw = await captureRemote(
        target,
        `bash -c ${shellQuote(captureFrameScript(vmid, remoteTmp, label))}`
    ).catch(() => '')
    const trimmed = raw.trim()
    if (!trimmed || trimmed === CAPTURE_SENTINEL) return null
    try {
        const gzipped = Buffer.from(trimmed, 'base64')
        return { analysis: analyzeFrame(gunzipSync(gzipped)), gzipped }
    } catch {
        return null
    }
}

/**
 * Frames are gzipped PPM, matching the build recorder's ring buffer — PVE's
 * qemu is commonly built without libpng, so PNG is not universally available.
 */
export const saveFrame = async (
    dir: string,
    label: string,
    frame: CapturedFrame
): Promise<string> => {
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${label}.ppm.gz`)
    await writeFile(path, frame.gzipped)
    return path
}
