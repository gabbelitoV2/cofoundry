import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    buildLeaseAdmissionScript,
    RUN_LEASE_DIR,
    sweepRunLeasesScript,
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
})
