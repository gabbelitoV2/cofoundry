import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    buildLeaseAdmissionScript,
    evaluateHeartbeat,
    HEARTBEAT_GONE_EXIT,
    HEARTBEAT_LOST_AFTER_FAILURES,
    killLeasedRunProcessesCommand,
    OWNED_VMID_DIR,
    RUN_LEASE_DIR,
    runLeaseHeartbeatCommand,
    sweepRunLeasesScript,
    updateLeaseVmidScript,
} from '@/build/lease.ts'
import { PACKER_TMP_ROOT } from '@/build/packer.ts'

const recipe = {
    name: 'debian-12',
    buildMemoryMb: 2048,
    buildCores: 2,
} as RecipeInfo

describe('node-wide run leases', () => {
    test('renders valid admission shell with resource and recipe gates', () => {
        const script = buildLeaseAdmissionScript(
            {
                CF_BUILD_MEMORY_BUDGET_MB: 8192,
                CF_BUILD_CPU_BUDGET: 4,
            } as Env,
            {
                id: 'run-id',
                kind: 'build',
                recipe,
                remoteTmpDir: '/dump/cofoundry-tmp/build-debian-12-run-id',
                packerTmpDir: `${PACKER_TMP_ROOT}/run-id`,
                preserveVm: false,
                storage: 'local',
            }
        )
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain('flock -x 9')
        expect(script).toContain('same_recipe=1')
        expect(script).toContain('memory_budget=8192')
        expect(script).toContain('cpu_budget=4')
        expect(script).toContain(`${PACKER_TMP_ROOT}/run-id`)
    })

    test('stale cleanup is scoped to resources named by a lease', () => {
        const script = sweepRunLeasesScript()
        expect(script).toContain(RUN_LEASE_DIR)
        expect(script).toContain('qm destroy "$vmid"')
        expect(script).toContain('*/cofoundry-tmp/build-*')
        expect(script).toContain(`${PACKER_TMP_ROOT}/*`)
        expect(script).toContain('rm -rf -- "$packer_tmpdir"')
        expect(script).not.toContain('qm list')
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('records VMID ownership for later telemetry cleanup', () => {
        const script = updateLeaseVmidScript(
            {
                id: 'run-id',
                kind: 'build',
                recipe,
                remoteTmpDir: '/dump/cofoundry-tmp/build-debian-12-run-id',
                packerTmpDir: `${PACKER_TMP_ROOT}/run-id`,
                preserveVm: false,
                storage: 'local',
            },
            400100
        )
        expect(script).toContain(`${OWNED_VMID_DIR}/400100`)
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})

describe('run-lease heartbeat lost detection', () => {
    const withTempDir = (fn: (dir: string) => void): void => {
        const dir = mkdtempSync(join(tmpdir(), 'cf-lease-'))
        try {
            // Forward slashes so Git Bash accepts the path on Windows too.
            fn(dir.replaceAll('\\', '/'))
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    test('heartbeat touches an existing lease file and exits 0', () => {
        withTempDir(dir => {
            const file = `${dir}/lease`
            writeFileSync(file, 'build\tdebian-12\t0\n')
            const cmd = runLeaseHeartbeatCommand(file)
            const syntax = spawnSync('bash', ['-n'], {
                input: cmd,
                encoding: 'utf8',
            })
            expect(syntax.status, syntax.stderr).toBe(0)
            const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(0)
        })
    })

    test('heartbeat reports a reaped lease with a distinct exit code', () => {
        withTempDir(dir => {
            const result = spawnSync(
                'bash',
                ['-c', runLeaseHeartbeatCommand(`${dir}/gone`)],
                { encoding: 'utf8' }
            )
            expect(result.status).toBe(HEARTBEAT_GONE_EXIT)
            // Must stay distinguishable from ssh's transport-failure status.
            expect(HEARTBEAT_GONE_EXIT).not.toBe(255)
        })
    })

    test('a successful heartbeat resets the consecutive-failure count', () => {
        const state = { failures: 0 }
        expect(evaluateHeartbeat(state, 255)).toBe('failing')
        expect(state.failures).toBe(1)
        expect(evaluateHeartbeat(state, 0)).toBe('alive')
        expect(state.failures).toBe(0)
    })

    test('a confirmed-missing lease file is lost immediately', () => {
        const state = { failures: 0 }
        expect(evaluateHeartbeat(state, HEARTBEAT_GONE_EXIT)).toBe('gone')
    })

    test('an unreachable node loses the lease only past the stale window', () => {
        const state = { failures: 0 }
        for (let i = 1; i < HEARTBEAT_LOST_AFTER_FAILURES; i++) {
            expect(evaluateHeartbeat(state, 255)).toBe('failing')
        }
        expect(evaluateHeartbeat(state, 255)).toBe('lost')
        expect(state.failures).toBe(HEARTBEAT_LOST_AFTER_FAILURES)
    })
})

describe('killLeasedRunProcessesCommand', () => {
    const tmpDir = '/dump/cofoundry-tmp/build-debian-12-abc'

    test('mirrors the sweep: kill by the run temp directory, force -9', () => {
        const cmd = killLeasedRunProcessesCommand(tmpDir)
        expect(cmd).toContain(
            "pkill -9 -f -- '/[d]ump/cofoundry-tmp/build-debian-12-abc'"
        )
        // The stale-lease sweep must keep using the same reap pattern, so a
        // local abort leaves the node exactly as a sweep would.
        expect(sweepRunLeasesScript()).toContain('pkill -9 -f -- "$tmpdir"')
        const syntax = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(syntax.status, syntax.stderr).toBe(0)
    })

    test('the pattern matches the run but never its own command line', () => {
        const cmd = killLeasedRunProcessesCommand(tmpDir)
        const quoted = /'([^']+)'/.exec(cmd)
        expect(quoted).not.toBeNull()
        const pattern = new RegExp(quoted![1]!)
        // Matches a real packer/tail argv that names the run directory...
        expect(
            pattern.test(`packer build -var-file ${tmpDir}/repo/v.json`)
        ).toBe(true)
        // ...but not the shell that carries the kill command itself, which
        // pkill -9 would otherwise terminate mid-flight.
        expect(pattern.test(`bash -c ${cmd}`)).toBe(false)
    })

    test('exits 0 when nothing matched (the sweep already killed the run)', () => {
        // pkill returns non-zero on no match — and may be missing entirely on
        // dev machines — so the command must still succeed either way.
        const result = spawnSync(
            'bash',
            ['-c', killLeasedRunProcessesCommand('/nonexistent/cf-tmp-none')],
            { encoding: 'utf8' }
        )
        expect(result.status, result.stderr).toBe(0)
    })
})
