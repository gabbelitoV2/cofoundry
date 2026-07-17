import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { buildSlotAllocationScript } from '@/build/netslot.ts'

describe('buildSlotAllocationScript', () => {
    test('is valid Bash and derives addresses from the configured bridge', () => {
        const script = buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain("bridge='vmbr1'")
        expect(script).toContain('bridge_cidr=$(ip -4')
        expect(script).toContain('if fits_block 100')
    })
})
