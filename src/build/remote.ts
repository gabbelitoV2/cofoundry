import { execa, ExecaError } from 'execa'
import { redactSensitive } from '../util.ts'

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
    for (const fn of cleanupCallbacks) fn()
    process.exit(128 + signo)
}
process.once('SIGINT', onFatalSignal(2))
process.once('SIGTERM', onFatalSignal(15))
process.once('SIGHUP', onFatalSignal(1))

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

export const remoteStreaming = (
    target: string,
    cmd: string,
    onLine?: (line: string) => void
): Promise<void> => streaming('ssh', [...SSH_OPTS, target, cmd], onLine)

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

// Runs a remote wget via SSH with a forced PTY (-t -t) so wget detects a
// terminal and streams live progress. 2>&1 merges wget's stderr (where it
// writes the bar) into the PTY stdout that we capture.
export const remoteWgetCapture = async (
    target: string,
    cmd: string,
    onLine: (line: string) => void,
    context?: { url?: string; what?: string }
): Promise<void> => {
    const proc = execa('ssh', [...SSH_OPTS, '-t', '-t', target, `{ ${cmd}; } 2>&1`], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
    })
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
            throw new Error(
                `${what} failed: wget exit ${code} — ${meaning}${url ? ` (${url.trim()})` : ''}`
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
    onLine?: (line: string) => void
): Promise<void> => {
    try {
        if (!onLine) {
            await execa(cmd, args, { stdio: 'inherit' })
            return
        }
        const proc = execa(cmd, args, {
            // ignore (not inherit): a long packer stream must not hold the shared
            // stdin and starve concurrent prefetch ssh calls. See captureRemote.
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        })
        activeProcs.add(proc as unknown as KillableProc)
        let buf = ''
        const onChunk = (chunk: Buffer): void => {
            buf += chunk.toString()
            const parts = buf.split(/\r?\n/)
            buf = parts.pop() ?? ''
            for (const part of parts) if (part) onLine(part)
        }
        proc.stdout?.on('data', onChunk)
        proc.stderr?.on('data', onChunk)
        try {
            await proc
            if (buf) onLine(buf)
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
