import { spawn } from 'node:child_process'
import { execa, ExecaError } from 'execa'
import { redactSensitive } from '@/util.ts'

// Keep idle SSH sessions alive — and detect a dead peer — so a long quiet remote
// step (e.g. a multi-hundred-MB artifact upload in CF_UPLOAD_CMD) can't leave the
// build hanging forever on a half-open connection.
const SSH_OPTS = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=6']

// ── SIGINT cleanup ────────────────────────────────────────────────────────────

type KillableProc = { kill: (signal?: string) => boolean }
const activeProcs = new Set<KillableProc>()
const cleanupCallbacks = new Set<() => void>()

/** Register a synchronous cleanup callback that runs on SIGINT before exit.
 *  Returns a deregister function. */
export const registerCleanup = (fn: () => void): (() => void) => {
    cleanupCallbacks.add(fn)
    return () => cleanupCallbacks.delete(fn)
}

// Run cleanup on any signal that would otherwise terminate the process without
// unwinding the build's `finally` blocks — SIGTERM (default `kill`, CI cancel/
// timeout) and SIGHUP (terminal/SSH session hangup) as well as SIGINT (Ctrl-C).
// This is best-effort: SIGKILL, OOM, and power loss can't be trapped, which is
// why netslot allocation also reclaims orphaned slots. Exit code is 128 + signo.
const onFatalSignal = (signo: number) => (): void => {
    for (const p of activeProcs) p.kill('SIGKILL')
    // Unwind LIFO, like nested `finally` blocks: the most-recently-acquired
    // resource is released first. Build acquires a netslot, then the build VM,
    // so VM-destroy must run before slot-release — otherwise a kill landing
    // between them frees the slot while its VM lives on, leaving an unmarked
    // orphan that squats the slot IP for whoever reuses it next.
    for (const fn of [...cleanupCallbacks].reverse()) fn()
    process.exit(128 + signo)
}

/**
 * Install process-level cleanup explicitly from the application boundary.
 * Importing this module has no signal-handler side effects.
 */
export const installRemoteSignalHandlers = (): (() => void) => {
    const handlers = [
        ['SIGINT', onFatalSignal(2)],
        ['SIGTERM', onFatalSignal(15)],
        ['SIGHUP', onFatalSignal(1)],
    ] as const
    for (const [signal, handler] of handlers) process.once(signal, handler)
    return () => {
        for (const [signal, handler] of handlers)
            process.removeListener(signal, handler)
    }
}

export const captureRemote = async (
    target: string,
    cmd: string
): Promise<string> => {
    try {
        // stdin: 'ignore' (≈ ssh -n), never 'inherit'. Concurrent ssh calls that
        // inherit the shared interactive stdin fight over fd 0 and block — the
        // classic "parallel ssh eats stdin" deadlock that stalls prefetch
        // (mkdir/file-check) for later recipes while an earlier build streams.
        const { stdout } = await execa('ssh', [...SSH_OPTS, target, cmd], {
            stdin: 'ignore',
            stderr: 'inherit',
        })
        return stdout
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(
                `"ssh" not found — is it installed and on your PATH?`
            )
        }
        if (err instanceof Error) throw new Error(redactSensitive(err.message))
        throw err
    }
}

/**
 * Stream a gzip tarball of a remote directory back as a Buffer. Uses `spawn`
 * with manual chunk collection rather than execa's `encoding: 'buffer'`, which
 * Bun's child_process shim rejects. Binary-safe, unlike captureRemote (utf8). A
 * missing directory (or any ssh error) yields an empty archive rather than
 * throwing, so callers on a best-effort path (diagnostics) needn't pre-check.
 */
export const remoteTarball = (
    target: string,
    remoteDir: string
): Promise<Buffer> =>
    new Promise(resolve => {
        const cmd = `if [ -d ${remoteDir} ]; then tar -C ${remoteDir} -czf - . 2>/dev/null; fi`
        const child = spawn('ssh', [...SSH_OPTS, target, cmd], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
        const chunks: Buffer[] = []
        child.stdout.on('data', (c: Buffer) => chunks.push(c))
        child.on('error', () => resolve(Buffer.alloc(0)))
        child.on('close', () => resolve(Buffer.concat(chunks)))
    })

export const remoteStreaming = (
    target: string,
    cmd: string,
    onLine?: (line: string) => void
): Promise<void> => streaming('ssh', [...SSH_OPTS, target, cmd], onLine)

/**
 * Capture stdout of a remote Bash script delivered over SSH stdin (`bash -s`),
 * so a script containing credentials never appears in sshd's process command
 * line. Capture-variant of remoteStreamingScript; used by `cf doctor` for the
 * bundled node sweep and the token-authenticated API probe. stderr is captured
 * separately so it cannot pollute the parsed stdout — on failure execa folds it
 * into the thrown (redacted) error message.
 */
export const captureRemoteScript = async (
    target: string,
    script: string
): Promise<string> => {
    try {
        const { stdout } = await execa(
            'ssh',
            [...SSH_OPTS, target, 'bash -s'],
            {
                input: script,
                stderr: 'pipe',
            }
        )
        return stdout
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(
                `"ssh" not found — is it installed and on your PATH?`
            )
        }
        if (err instanceof Error) throw new Error(redactSensitive(err.message))
        throw err
    }
}

/**
 * Run a remote Bash script without putting its contents in sshd's process
 * command line. This is the required path for scripts containing credentials:
 * SSH carries the script over stdin and the remote argv is only `bash -s`.
 */
export const remoteStreamingScript = (
    target: string,
    script: string,
    onLine?: (line: string) => void
): Promise<void> =>
    streaming('ssh', [...SSH_OPTS, target, 'bash -s'], onLine, script)

// Allocates a PTY so remote programs (e.g. wget) detect a terminal and show
// their native progress bar rather than falling back to dot-style output.
export const remoteStreamingPty = (
    target: string,
    cmd: string
): Promise<void> => streaming('ssh', [...SSH_OPTS, '-t', '-t', target, cmd])

// Wget exit codes worth surfacing. See man wget(1) EXIT STATUS.
const WGET_EXIT: Record<number, string> = {
    1: 'generic error',
    2: 'parse error (bad command line)',
    3: 'file I/O error (cannot write to destination)',
    4: 'network failure (DNS/connect)',
    5: 'SSL verification failure',
    6: 'authentication failure',
    7: 'protocol error',
    8: 'server returned an error response (e.g. 404 — URL may be stale)',
}

// A wget failure that carries its exit code, so callers can distinguish a
// transient fault (retry) from a permanent one (a stale URL / 404 — exit 8 —
// or a bad-invocation exit 2, where retrying only wastes backoff).
export class WgetError extends Error {
    constructor(
        message: string,
        readonly exitCode: number
    ) {
        super(message)
        this.name = 'WgetError'
    }
}

// wget exit codes that will never succeed on retry: a stale/absent URL and a
// malformed command line. Everything else is treated as potentially transient.
export const isPermanentWgetExit = (code: number): boolean =>
    code === 8 || code === 2

// Runs a remote wget via SSH with a forced PTY (-t -t) so wget detects a
// terminal and streams live progress. 2>&1 merges wget's stderr (where it
// writes the bar) into the PTY stdout that we capture.
export const remoteWgetCapture = async (
    target: string,
    cmd: string,
    onLine: (line: string) => void,
    context?: { url?: string; what?: string }
): Promise<void> => {
    const proc = execa(
        'ssh',
        [...SSH_OPTS, '-t', '-t', target, `{ ${cmd}; } 2>&1`],
        {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
        }
    )
    proc.stdin?.end() // wget doesn't use stdin; close to avoid a dangling fd
    activeProcs.add(proc as unknown as KillableProc)

    let buf = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const parts = buf.split(/[\n\r]+/)
        buf = parts.pop() ?? ''
        for (const part of parts) {
            if (part.trim()) onLine(part)
        }
    })

    try {
        await proc
        if (buf.trim()) onLine(buf)
    } catch (err) {
        if (buf.trim()) onLine(buf)
        if (err instanceof ExecaError && err.code === 'ENOENT')
            throw new Error(
                `"ssh" not found — is it installed and on your PATH?`
            )
        if (err instanceof ExecaError && typeof err.exitCode === 'number') {
            const code = err.exitCode
            const meaning = WGET_EXIT[code] ?? 'unknown wget error'
            const what = context?.what ?? 'download'
            const url = context?.url ? ` ${context.url}` : ''
            throw new WgetError(
                `${what} failed: wget exit ${code} — ${meaning}${url ? ` (${url.trim()})` : ''}`,
                code
            )
        }
        if (err instanceof Error) throw new Error(redactSensitive(err.message))
        throw err
    } finally {
        activeProcs.delete(proc as unknown as KillableProc)
    }
}

export const streaming = async (
    cmd: string,
    args: string[],
    onLine?: (line: string) => void,
    input?: string
): Promise<void> => {
    try {
        const proc = execa(cmd, args, {
            // A supplied script owns stdin. Otherwise preserve the existing
            // behavior: ignored for captured streams (so concurrent SSH calls
            // cannot steal stdin), inherited for interactive passthrough.
            stdin:
                input === undefined ? (onLine ? 'ignore' : 'inherit') : 'pipe',
            stdout: onLine ? 'pipe' : 'inherit',
            stderr: onLine ? 'pipe' : 'inherit',
        })
        if (input !== undefined) proc.stdin?.end(input)
        activeProcs.add(proc as unknown as KillableProc)
        if (!onLine) {
            try {
                await proc
            } finally {
                activeProcs.delete(proc as unknown as KillableProc)
            }
            return
        }
        // Assemble lines per stream. stdout and stderr arrive as independent
        // chunk sequences, so a partial line held from one must never be spliced
        // onto the other: a single shared buffer corrupts — and can drop — lines
        // at the boundary whenever both streams are active at once.
        const flushers: Array<() => void> = []
        const attach = (stream: NodeJS.ReadableStream | null): void => {
            if (!stream) return
            let buf = ''
            stream.on('data', (chunk: Buffer) => {
                buf += chunk.toString()
                const parts = buf.split(/\r?\n/)
                buf = parts.pop() ?? ''
                for (const part of parts) if (part) onLine(part)
            })
            flushers.push(() => {
                if (buf) onLine(buf)
            })
        }
        attach(proc.stdout)
        attach(proc.stderr)
        try {
            await proc
            for (const flush of flushers) flush()
        } finally {
            activeProcs.delete(proc as unknown as KillableProc)
        }
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(
                `"${cmd}" not found — is it installed and on your PATH?`
            )
        }
        if (err instanceof Error) throw new Error(redactSensitive(err.message))
        throw err
    }
}
