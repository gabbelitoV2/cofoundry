import { createLogUpdate } from 'log-update'
import cliSpinners from 'cli-spinners'
import figures from 'figures'
import cliTruncate from 'cli-truncate'
import pc from 'picocolors'
import { fmtDuration } from './format.ts'

export type TaskHandle = {
    /** Discrete phase change (e.g. "download", "verify", "install · VMID 9000"). */
    setPhase(phase: string): void
    /** Transient progress detail. Live in TTY, dropped in stream mode. */
    setProgress(progress: string): void
    /** Permanent log line. Ring-buffered in TTY, streamed verbatim otherwise. */
    log(line: string): void
    succeed(message?: string): void
    fail(error: string): void
}

export type Renderer = {
    task(name: string): TaskHandle
    /** Standalone log line outside any task row. */
    note(msg: string): void
    finish(): void
}

export type RendererOptions = {
    title?: string
    verbose?: boolean
    ci?: boolean
    outputLines?: number
    queuedPattern?: RegExp
    stream?: NodeJS.WritableStream
}

const QUEUED = /\bqueued\b/

type State = {
    name: string
    phase: string
    progress?: string
    logs: string[]
    activeMs: number
    activeSinceMs?: number
    endMs?: number
    result?: 'ok' | 'fail'
    message?: string
    error?: string
    persisted?: boolean
}

class LiveRenderer implements Renderer {
    private readonly tasks = new Map<string, State>()
    private readonly order: string[] = []
    private readonly timer: ReturnType<typeof setInterval>
    private readonly spinner = cliSpinners.dots
    private readonly logCapacity: number
    private readonly write: ReturnType<typeof createLogUpdate>
    private readonly title?: string
    private readonly queuedPattern: RegExp
    private readonly stream: NodeJS.WritableStream
    private frame = 0
    private extraNotes: string[] = []

    constructor(opts: {
        outputLines: number
        title?: string
        queuedPattern: RegExp
        stream: NodeJS.WritableStream
    }) {
        this.logCapacity = opts.outputLines
        this.title = opts.title
        this.queuedPattern = opts.queuedPattern
        this.stream = opts.stream
        this.write = createLogUpdate(opts.stream)
        this.timer = setInterval(() => this.render(), 120)
        this.timer.unref?.()
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
                state.progress = undefined
                state.logs.length = 0
                const queued = this.queuedPattern.test(phase)
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
            succeed: message => {
                if (state.activeSinceMs !== undefined) {
                    state.activeMs += Date.now() - state.activeSinceMs
                    state.activeSinceMs = undefined
                }
                state.endMs = Date.now()
                state.result = 'ok'
                state.message = message
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
                this.persistFailure(state)
            },
        }
    }

    note(msg: string): void {
        this.extraNotes.push(msg)
    }

    private elapsed(s: State): number {
        return (
            s.activeMs +
            (s.activeSinceMs !== undefined ? Date.now() - s.activeSinceMs : 0)
        )
    }

    private head(s: State, frame: string): string {
        const icon =
            s.result === 'ok'
                ? pc.green(figures.tick)
                : s.result === 'fail'
                  ? pc.red(figures.cross)
                  : pc.cyan(frame)
        const phaseText = s.result === 'ok' ? (s.message ?? 'done') : s.phase
        const status = s.progress
            ? `${phaseText} ${pc.dim('·')} ${s.progress}`
            : phaseText
        const elapsed = this.elapsed(s)
        const timer =
            elapsed === 0 ? '' : ` ${pc.dim(`[${fmtDuration(elapsed)}]`)}`
        return `${icon} ${pc.bold(s.name)} ${pc.dim('·')} ${status}${timer}`
    }

    private errorLines(error: string): string[] {
        return error
            .split(/\r?\n/)
            .map((line, index) =>
                index === 0
                    ? `    ${pc.red(figures.cross)} ${line}`
                    : `      ${line}`
            )
    }

    private persistFailure(s: State): void {
        if (s.persisted) return
        s.persisted = true
        const out = [this.head(s, this.spinner.frames[0]!)]
        for (const log of s.logs) out.push(`    ${pc.dim('›')} ${log}`)
        if (s.error) out.push(...this.errorLines(s.error))

        // Move the current live frame out of the way, pin the complete failure
        // in scrollback, then immediately redraw the remaining tasks below it.
        // `persist` wraps long lines instead of truncating them, so the useful
        // tail of an error is visible while other tasks continue to run.
        this.write.persist(out.join('\n'))
        this.render()
    }

    private render(): void {
        const cols =
            (this.stream as { columns?: number }).columns ||
            process.stdout.columns ||
            100
        const frame =
            this.spinner.frames[this.frame % this.spinner.frames.length]!
        this.frame++

        const out: string[] = []
        if (this.title) out.push(pc.bold(this.title))
        for (const note of this.extraNotes) {
            out.push(cliTruncate(`${pc.dim(figures.info)} ${note}`, cols))
        }
        for (const name of this.order) {
            const s = this.tasks.get(name)!
            if (s.persisted) continue
            out.push(cliTruncate(this.head(s, frame), cols))
            for (const log of s.logs) {
                out.push(cliTruncate(`    ${pc.dim('›')} ${log}`, cols))
            }
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

class StreamRenderer implements Renderer {
    private readonly stream: NodeJS.WritableStream
    private readonly title?: string
    private headerPrinted = false

    constructor(opts: { title?: string; stream: NodeJS.WritableStream }) {
        this.stream = opts.stream
        this.title = opts.title
    }

    private writeHeader(): void {
        if (this.headerPrinted || !this.title) return
        this.headerPrinted = true
        this.stream.write(`${pc.bold(this.title)}\n`)
    }

    task(name: string): TaskHandle {
        this.writeHeader()
        const start = Date.now()
        const tag = pc.cyan(`[${name}]`)
        const write = (s: string): void => {
            this.stream.write(`${tag} ${s}\n`)
        }
        // Progress arrives many times a second (wget bars, transfer ticks).
        // Stream mode has no in-place updates, so throttle to one line/sec to
        // keep prefetch/sync visible without flooding CI logs.
        let lastProgressMs = 0
        return {
            setPhase: phase => {
                lastProgressMs = 0
                write(`${pc.dim('→')} ${phase}`)
            },
            setProgress: progress => {
                const now = Date.now()
                if (now - lastProgressMs < 1000) return
                lastProgressMs = now
                write(`${pc.dim('·')} ${progress}`)
            },
            log: line => write(line),
            succeed: message => {
                const d = fmtDuration(Date.now() - start)
                const tail = message ? ` ${message}` : ''
                write(
                    `${pc.green(figures.tick)} done${tail} ${pc.dim(`(${d})`)}`
                )
            },
            fail: err => {
                const d = fmtDuration(Date.now() - start)
                write(
                    `${pc.red(figures.cross)} failed ${pc.dim(`(${d})`)}: ${err}`
                )
            },
        }
    }

    note(msg: string): void {
        this.writeHeader()
        this.stream.write(`${pc.cyan(figures.info)} ${msg}\n`)
    }

    finish(): void {}
}

export const createRenderer = (opts: RendererOptions = {}): Renderer => {
    const stream = opts.stream ?? process.stderr
    const isTty =
        (stream as { isTTY?: boolean }).isTTY === true ||
        (stream === process.stderr && process.stderr.isTTY)
    const useStream = opts.verbose || opts.ci || !isTty
    if (useStream) return new StreamRenderer({ title: opts.title, stream })
    return new LiveRenderer({
        outputLines: Math.max(1, opts.outputLines ?? 1),
        title: opts.title,
        queuedPattern: opts.queuedPattern ?? QUEUED,
        stream,
    })
}
