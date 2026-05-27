import { execa, ExecaError } from 'execa'
import { redactSensitive } from '../util.ts'

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

process.once('SIGINT', () => {
    for (const p of activeProcs) p.kill('SIGKILL')
    for (const fn of cleanupCallbacks) fn()
    process.exit(130)
})

export const captureRemote = async (
    target: string,
    cmd: string
): Promise<string> => {
    try {
        const { stdout } = await execa('ssh', [target, cmd], {
            stdin: 'inherit',
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
): Promise<void> => streaming('ssh', [target, cmd], onLine)

// Allocates a PTY so remote programs (e.g. wget) detect a terminal and show
// their native progress bar rather than falling back to dot-style output.
export const remoteStreamingPty = (
    target: string,
    cmd: string
): Promise<void> => streaming('ssh', ['-t', '-t', target, cmd])

// Runs a remote wget via SSH with a forced PTY (-t -t) so wget detects a
// terminal and streams live progress. 2>&1 merges wget's stderr (where it
// writes the bar) into the PTY stdout that we capture.
export const remoteWgetCapture = async (
    target: string,
    cmd: string,
    onLine: (line: string) => void
): Promise<void> => {
    const proc = execa('ssh', ['-t', '-t', target, `{ ${cmd}; } 2>&1`], {
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
            throw new Error(`"ssh" not found — is it installed and on your PATH?`)
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
            stdin: 'inherit',
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
