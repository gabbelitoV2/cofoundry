import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { reserveScratchVmidScript } from '@/verify.ts'

describe('verify VMID reservation', () => {
    test('selects and records a VMID while holding the node lock', () => {
        const script = reserveScratchVmidScript('owner-id')
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain('flock -x 9')
        expect(script).toContain('/verify-reservations/owner-id')
        expect(script).toContain('qm destroy "$stale_vmid"')
        expect(script).toContain('seq 9500 9999')
    })
})
