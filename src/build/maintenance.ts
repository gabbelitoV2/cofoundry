import { spawn } from 'node:child_process'
import { registerCleanup } from '@/build/remote.ts'
import { shellQuote } from '@/util.ts'

export const MAINTENANCE_LOCK = '/var/lib/cofoundry/maintenance.lock'

export type MaintenanceLockMode = 'shared' | 'exclusive'

const ACQUIRED_MARKER = '__CF_MAINTENANCE_LOCK_ACQUIRED__'

export const maintenanceLockCommand = (mode: MaintenanceLockMode): string =>
    `mkdir -p ${shellQuote(MAINTENANCE_LOCK.replace(/\/[^/]+$/, ''))}; ` +
    `exec flock ${mode === 'shared' ? '-s' : '-x'} ${shellQuote(MAINTENANCE_LOCK)} ` +
    `sh -c ${shellQuote(`printf '${ACQUIRED_MARKER}\\n'; cat >/dev/null`)}`

export type RemoteMaintenanceLock = {
    lost: Promise<never>
    release: () => Promise<void>
}

/**
 * Hold a flock on the node for the lifetime of an SSH connection. Builds and
 * verifies take the shared side, so they remain parallel with each other;
 * destructive maintenance takes the exclusive side and therefore cannot race
 * repository upload, prefetch, Packer, artifact handling, or verification.
 *
 * The remote `cat` keeps the lock holder alive until release closes stdin. A
 * local crash also closes the SSH connection, so the kernel releases the flock
 * without a stale-marker protocol or timeout.
 */
export const acquireRemoteMaintenanceLock = async (
    target: string,
    mode: MaintenanceLockMode
): Promise<RemoteMaintenanceLock> => {
    const child = spawn(
        'ssh',
        [
            '-o',
            'ServerAliveInterval=30',
            '-o',
            'ServerAliveCountMax=3',
            target,
            maintenanceLockCommand(mode),
        ],
        { stdio: ['pipe', 'pipe', 'inherit'] }
    )
    let released = false
    const unregister = registerCleanup(() => child.kill('SIGTERM'))

    try {
        await new Promise<void>((resolve, reject) => {
            let output = ''
            const cleanupListeners = (): void => {
                child.stdout.off('data', onData)
                child.off('error', onError)
                child.off('exit', onExit)
            }
            const onData = (chunk: Buffer): void => {
                output += chunk.toString('utf8')
                if (!output.includes(ACQUIRED_MARKER)) return
                cleanupListeners()
                resolve()
            }
            const onError = (error: Error): void => {
                cleanupListeners()
                reject(error)
            }
            const onExit = (code: number | null): void => {
                cleanupListeners()
                reject(
                    new Error(
                        `remote maintenance lock exited before acquisition (${code ?? 'signal'})`
                    )
                )
            }
            child.stdout.on('data', onData)
            child.once('error', onError)
            child.once('exit', onExit)
        })
    } catch (error) {
        unregister()
        child.kill('SIGTERM')
        throw error
    }

    let rejectLost: (error: Error) => void = () => undefined
    const lost = new Promise<never>((_resolve, reject) => {
        rejectLost = reject
    })
    // Callers race their work against `lost`. Keep a handler attached during
    // the small hand-off window between acquisition and that race.
    void lost.catch(() => undefined)
    const lockLost = (detail: string): void => {
        if (released) return
        rejectLost(
            new Error(
                `remote maintenance lock was lost while in use (${detail})`
            )
        )
    }
    child.once('error', error => lockLost(error.message))
    child.once('close', (code, signal) =>
        lockLost(signal ?? String(code ?? 'unknown exit'))
    )
    if (child.exitCode !== null || child.signalCode !== null)
        lockLost(child.signalCode ?? String(child.exitCode))

    return {
        lost,
        release: async () => {
            if (released) return
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(
                    `remote maintenance lock was lost before release (${child.signalCode ?? child.exitCode})`
                )
            }
            released = true
            unregister()
            const exited = new Promise<number | null>((resolve, reject) => {
                child.once('error', reject)
                child.once('close', resolve)
            })
            child.stdin.end()
            const code =
                child.exitCode === null && child.signalCode === null
                    ? await exited
                    : child.exitCode
            if (code !== 0) {
                throw new Error(
                    `remote maintenance lock release failed (${code ?? 'signal'})`
                )
            }
        },
    }
}
