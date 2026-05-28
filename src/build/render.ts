// Custom renderer for the build pipeline.
//
// Two implementations behind one Renderer interface:
//   - LiveRenderer (TTY): in-place multi-row layout via `log-update`.
//   - StreamRenderer (CI/verbose): line-oriented stream to stderr.
//
// Both share the same TaskHandle API so pipeline.ts is renderer-agnostic.

import { createLogUpdate } from 'log-update'
import cliSpinners from 'cli-spinners'
import figures from 'figures'
import prettyMs from 'pretty-ms'
import cliTruncate from 'cli-truncate'
import pc from 'picocolors'

export type TaskHandle = {
    /** Discrete state change (e.g. "prefetch", "build · queued (3 ahead)"). Always logged in stream mode. */
    setPhase(phase: string): void
    /** Transient progress (wget %, sftp %). Live in TTY, dropped in stream mode. */
    setProgress(progress: string): void
    /** Permanent log line (packer output). Always streamed; ring-buffered in TTY. */
    log(line: string): void
    succeed(): void
    fail(error: string): void
}

export type Renderer = {
    task(name: string): TaskHandle
    finish(): void
}

export type RendererOptions = {
    verbose?: boolean
    ci?: boolean
    outputLines?: number
}

const formatDuration = (ms: number): string =>
    prettyMs(ms, { compact: false, secondsDecimalDigits: 0, keepDecimalsOnWholeSeconds: false })

// ── LiveRenderer (TTY) ───────────────────────────────────────────────────────

type State = {
    name: string
    phase: string
    progress?: string
    logs: string[]
    // Active-time accounting: timer only advances while the task is out of a
    // queued phase. `activeSinceMs` is set on entry to a working phase and
    // cleared on entry to a queued phase, flushing elapsed into `activeMs`.
    activeMs: number
    activeSinceMs?: number
    endMs?: number
    result?: 'ok' | 'fail'
    error?: string
}

class LiveRenderer implements Renderer {
    private readonly tasks = new Map<string, State>()
    private readonly order: string[] = []
    private readonly timer: ReturnType<typeof setInterval>
    private readonly spinner = cliSpinners.dots
    private readonly logCapacity: number
    private readonly write = createLogUpdate(process.stderr)
    private frame = 0

    constructor(opts: { outputLines: number }) {
        this.logCapacity = opts.outputLines
        // 80ms tick: smooth spinner without burning CPU.
        this.timer = setInterval(() => this.render(), 80)
        this.timer.unref?.()
        // On resize, log-update's tracked line count is stale (rows previously
        // wrapped at the old width now occupy a different number of rows), so
        // clear-and-rewrite leaves ghosts. Clear its state and the next tick
        // redraws cleanly at the new width.
        process.stdout.on('resize', this.onResize)
    }

    private readonly onResize = (): void => {
        this.write.clear()
    }

    task(name: string): TaskHandle {
        const state: State = {
            name,
            phase: 'queued',
            logs: [],
            activeMs: 0,
        }
        this.tasks.set(name, state)
        this.order.push(name)
        return {
            setPhase: phase => {
                state.phase = phase
                // New phase invalidates progress AND scrollback — once the
                // build phase ends, packer logs aren't useful under a sync row.
                state.progress = undefined
                state.logs.length = 0
                const queued = /\bqueued\b/.test(phase)
                if (queued && state.activeSinceMs !== undefined) {
                    state.activeMs += Date.now() - state.activeSinceMs
                    state.activeSinceMs = undefined
                } else if (!queued && state.activeSinceMs === undefined) {
                    state.activeSinceMs = Date.now()
                }
            },
            setProgress: progress => {
                state.progress = progress
            },
            log: line => {
                state.logs.push(line)
                if (state.logs.length > this.logCapacity) state.logs.shift()
            },
            succeed: () => {
                if (state.activeSinceMs !== undefined) {
                    state.activeMs += Date.now() - state.activeSinceMs
                    state.activeSinceMs = undefined
                }
                state.endMs = Date.now()
                state.result = 'ok'
                state.progress = undefined
            },
            fail: err => {
                if (state.activeSinceMs !== undefined) {
                    state.activeMs += Date.now() - state.activeSinceMs
                    state.activeSinceMs = undefined
                }
                state.endMs = Date.now()
                state.result = 'fail'
                state.error = err
                state.progress = undefined
            },
        }
    }

    private render(): void {
        const cols = process.stderr.columns || 100
        const frame = this.spinner.frames[this.frame % this.spinner.frames.length]!
        this.frame++

        const out: string[] = []
        for (const name of this.order) {
            const s = this.tasks.get(name)!
            const icon =
                s.result === 'ok'
                    ? pc.green(figures.tick)
                    : s.result === 'fail'
                      ? pc.red(figures.cross)
                      : pc.cyan(frame)
            const status = s.progress ? `${s.phase} · ${s.progress}` : s.phase
            // Show accumulated active time; freeze while queued (timer is a
            // sum of completed work segments only).
            const elapsed =
                s.activeMs + (s.activeSinceMs !== undefined ? Date.now() - s.activeSinceMs : 0)
            const timer =
                elapsed === 0 ? '' : ` ${pc.dim(`[${formatDuration(elapsed)}]`)}`
            const head = `${icon} ${pc.bold(s.name)} ${pc.dim('·')} ${status}${timer}`
            out.push(cliTruncate(head, cols))
            for (const log of s.logs) {
                out.push(cliTruncate(`    ${pc.dim('›')} ${log}`, cols))
            }
            if (s.error) out.push(cliTruncate(`    ${pc.red(figures.cross)} ${s.error}`, cols))
        }
        this.write(out.join('\n'))
    }

    finish(): void {
        clearInterval(this.timer)
        process.stdout.off('resize', this.onResize)
        this.render()
        this.write.done()
    }
}

// ── StreamRenderer (CI / verbose) ────────────────────────────────────────────

class StreamRenderer implements Renderer {
    task(name: string): TaskHandle {
        const start = Date.now()
        const tag = pc.cyan(`[${name}]`)
        const write = (s: string): void => {
            process.stderr.write(`${tag} ${s}\n`)
        }
        return {
            setPhase: phase => write(`${pc.dim('→')} ${phase}`),
            setProgress: () => {
                // Transient — drop in stream mode. Progress lines spam logs and
                // are uninterpretable without ANSI overwriting.
            },
            log: line => write(line),
            succeed: () => {
                const d = formatDuration(Date.now() - start)
                write(`${pc.green(figures.tick)} done ${pc.dim(`(${d})`)}`)
            },
            fail: err => {
                const d = formatDuration(Date.now() - start)
                write(`${pc.red(figures.cross)} failed ${pc.dim(`(${d})`)}: ${err}`)
            },
        }
    }

    finish(): void {}
}

// ── factory ──────────────────────────────────────────────────────────────────

export const createRenderer = (opts: RendererOptions = {}): Renderer => {
    const stream = opts.verbose || opts.ci || !process.stderr.isTTY
    if (stream) return new StreamRenderer()
    return new LiveRenderer({ outputLines: Math.max(1, opts.outputLines ?? 1) })
}
