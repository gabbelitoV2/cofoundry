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
    reapLeasesByPrefixScript,
    runLeaseId,
    RUN_LEASE_STALE_SECS,
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

describe('run-targeted lease reap', () => {
    test('selects by prefix and, unlike the sweep, applies no age gate', () => {
        const script = reapLeasesByPrefixScript('12345-1')
        // The directory is quoted; the prefix and glob deliberately are not, so
        // the shell still expands the match.
        expect(script).toContain(`'${RUN_LEASE_DIR}'/12345-1*`)
        // The whole point: a lease seconds old must still be reaped, because
        // the run that owned it is known dead.
        expect(script).not.toContain('stat -c %Y')
        expect(script).not.toContain(String(RUN_LEASE_STALE_SECS))
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('frees exactly what the age-gated sweep frees', () => {
        // Both paths share one reap body, so a resource can never be released
        // by one and leaked by the other.
        const targeted = reapLeasesByPrefixScript('12345-1')
        for (const fragment of [
            'qm destroy "$vmid"',
            'pkill -9 -f -- "$tmpdir"',
            'rm -rf -- "$packer_tmpdir"',
            'rm -f -- "$lease"',
            '*/cofoundry-verify-*',
        ]) {
            expect(targeted).toContain(fragment)
            expect(sweepRunLeasesScript()).toContain(fragment)
        }
    })

    test('rejects a prefix that would widen the match or escape the directory', () => {
        // `*` would reap every live build on the node, age gate and all.
        for (const bad of ['*', '', '../../etc', 'run id', 'a/b', '12345*']) {
            expect(() => reapLeasesByPrefixScript(bad)).toThrow(
                /unsafe lease prefix/
            )
        }
    })
})

describe('runLeaseId', () => {
    test('is derivable from the CI run alone, without the build reporting it', () => {
        // A cancelled job is killed with no grace period, so the cleanup job can
        // only find the lease if it can compute the same id independently.
        expect(runLeaseId('12345-1', 'build', 'debian-12')).toBe(
            '12345-1-build-debian-12'
        )
        expect(runLeaseId('12345-1', 'verify', 'debian-12')).toBe(
            '12345-1-verify-debian-12'
        )
    })

    test('build and verify of one recipe share the run prefix but not the id', () => {
        const build = runLeaseId('12345-1', 'build', 'debian-12')
        const verify = runLeaseId('12345-1', 'verify', 'debian-12')
        expect(build).not.toBe(verify)
        expect(build.startsWith('12345-1')).toBe(true)
        expect(verify.startsWith('12345-1')).toBe(true)
        // One reap therefore clears both.
        expect(reapLeasesByPrefixScript('12345-1')).toContain('12345-1*')
    })

    test('falls back to a random id outside CI', () => {
        const a = runLeaseId(undefined, 'build', 'debian-12')
        expect(a).not.toBe(runLeaseId(undefined, 'build', 'debian-12'))
        expect(a).toMatch(/^[0-9a-f-]{36}$/)
    })

    test('sanitizes ids so they stay inert as a filename and a glob', () => {
        const id = runLeaseId('12345/../x *', 'build', 'ubuntu 24.04')
        expect(id).not.toMatch(/[/*\s]/)
        // Must survive the prefix validator it will later be matched by.
        expect(() => reapLeasesByPrefixScript(id)).not.toThrow()
    })
})
