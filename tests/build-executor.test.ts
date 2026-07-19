import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { buildWritableRepoCommand, raceLeasedWork } from '@/build/executor.ts'
import { destroyVmCommand } from '@/build/vm.ts'

describe('buildWritableRepoCommand', () => {
    test('dereferences the stable snapshot into a writable build copy', () => {
        const command = buildWritableRepoCommand(
            '/dump/cofoundry-work',
            '/dump/cofoundry-tmp/build-debian/repo'
        )

        expect(command).toContain(
            "cp -aL '/dump/cofoundry-work' '/dump/cofoundry-tmp/build-debian/repo'"
        )
        expect(command).toContain(
            "chmod -R u+w '/dump/cofoundry-tmp/build-debian/repo'"
        )
    })

    test('copies cached Windows media into only the build copy', () => {
        // The cache filename carries the pinned version; the copy in the build
        // repo keeps the version-less name the recipes reference.
        const command = buildWritableRepoCommand(
            '/dump/cofoundry-work',
            '/dump/cofoundry-tmp/build-windows/repo',
            '/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi'
        )

        expect(command).toContain(
            "install -m 0644 '/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi' '/dump/cofoundry-tmp/build-windows/repo/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
        expect(command).not.toContain(
            "'/dump/cofoundry-work/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
    })
})

describe('raceLeasedWork', () => {
    const neverLost = (): Promise<never> => new Promise<never>(() => undefined)

    test('normal completion neither aborts nor terminates the remote run', async () => {
        let terminated = 0
        let observed: AbortSignal | undefined
        await raceLeasedWork({
            run: async signal => {
                observed = signal
            },
            lost: neverLost(),
            terminateRemote: async () => {
                terminated++
            },
        })
        expect(terminated).toBe(0)
        expect(observed?.aborted).toBe(false)
    })

    test('a work failure propagates unchanged without remote termination', async () => {
        let terminated = 0
        await expect(
            raceLeasedWork({
                run: async () => {
                    throw new Error('packer exploded')
                },
                lost: neverLost(),
                terminateRemote: async () => {
                    terminated++
                },
            })
        ).rejects.toThrow('packer exploded')
        expect(terminated).toBe(0)
    })

    test('a lost lease aborts the work, kills the remote run, and only rejects after the work settled', async () => {
        const events: string[] = []
        const lostError = new Error('build run lease for debian-12 was lost')
        let rejectLost!: (error: Error) => void
        const lost = new Promise<never>((_resolve, reject) => {
            rejectLost = reject
        })
        let observed: AbortSignal | undefined
        const pending = raceLeasedWork({
            run: signal => {
                observed = signal
                return new Promise<void>(resolve => {
                    signal.addEventListener('abort', () => {
                        events.push('aborted')
                        // Settle a beat later, like a killed SSH child exiting.
                        setTimeout(() => {
                            events.push('work settled')
                            resolve()
                        }, 20)
                    })
                })
            },
            lost,
            terminateRemote: async () => {
                events.push('remote kill')
            },
        })
        rejectLost(lostError)
        // The rejection must be the explanatory lease-lost error, not a
        // generic cancellation, and the signal must carry it as its reason.
        await expect(pending).rejects.toBe(lostError)
        expect(observed?.reason).toBe(lostError)
        // Everything after raceLeasedWork (the caller's cleanup finally) must
        // only run once the remote kill was sent AND the work settled.
        expect(events).toEqual(['aborted', 'remote kill', 'work settled'])
    })

    test('the settle window is bounded when aborted work wedges', async () => {
        const lostError = new Error('lease lost while ssh is wedged')
        let stalled = 0
        const started = Date.now()
        await expect(
            raceLeasedWork({
                run: () => new Promise<void>(() => undefined), // never settles
                lost: new Promise<never>((_resolve, reject) =>
                    setTimeout(() => reject(lostError), 5)
                ),
                terminateRemote: async () => undefined,
                settleMs: 50,
                onStalled: () => {
                    stalled++
                },
            })
        ).rejects.toBe(lostError)
        expect(stalled).toBe(1)
        // Wedged work must not hold cleanup hostage past the window.
        expect(Date.now() - started).toBeLessThan(5_000)
    })

    test('a hung remote kill cannot extend the wait past the window', async () => {
        const lostError = new Error('lease lost on an unreachable node')
        let stalled = 0
        await expect(
            raceLeasedWork({
                run: signal =>
                    new Promise<void>(resolve => {
                        signal.addEventListener('abort', () => resolve())
                    }),
                lost: new Promise<never>((_resolve, reject) =>
                    setTimeout(() => reject(lostError), 5)
                ),
                // An unreachable node: the kill SSH never comes back.
                terminateRemote: () => new Promise<void>(() => undefined),
                settleMs: 50,
                onStalled: () => {
                    stalled++
                },
            })
        ).rejects.toBe(lostError)
        expect(stalled).toBe(1)
    })
})

describe('destroyVmCommand', () => {
    test('reclaims only orphaned volumes belonging to the destroyed VMID', () => {
        const command = destroyVmCommand(400100, 'local-lvm')
        expect(command).toContain("pvesm list 'local-lvm'")
        expect(command).toContain('$NF==vmid')
        expect(command).toContain('pvesm free "$volid"')
        expect(command).toContain('! qm config 400100')
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})
