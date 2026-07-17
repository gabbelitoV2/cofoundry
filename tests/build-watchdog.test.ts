import { describe, expect, test } from 'bun:test'
import { buildVmWatchdog } from '@/build/watchdog.ts'

describe('buildVmWatchdog', () => {
    test('interpolates VM identity and communicator', () => {
        const script = buildVmWatchdog(600201, '10.0.0.101', 5985, false)
        expect(script).toContain('qm status 600201')
        expect(script).toContain('/10.0.0.101/5985')
        expect(script).not.toContain('qm sendkey')
    })

    test('adds OVMF boot-key recovery only when requested', () => {
        expect(buildVmWatchdog(1, '10.0.0.1', 5985, true)).toContain(
            'qm sendkey 1 ret'
        )
    })
})
