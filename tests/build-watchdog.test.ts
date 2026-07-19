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

    test('kills the whole process group when the restart limit is reached', () => {
        const script = buildVmWatchdog(600201, '10.0.0.101', 5985, false)
        const branch = script.slice(
            script.indexOf('restart limit reached'),
            script.indexOf('stopped unexpectedly')
        )
        // A bare `exit 1` only ends the background subshell — Packer would
        // wait out its communicator timeout against the dead VM. The group
        // kill is what fails the attempt fast.
        expect(branch).toMatch(/kill 0[\s\S]*exit 1\b/)
    })

    test('healthy exits leave the process group untouched', () => {
        const script = buildVmWatchdog(600201, '10.0.0.101', 5985, false)
        const lines = script.split('\n')
        for (const marker of [
            'launching shell gone',
            'stable) — exiting',
            'is now a template',
        ]) {
            const line = lines.find(l => l.includes(marker))
            expect(line).toBeDefined()
            expect(line).toContain('exit 0')
            expect(line).not.toContain('kill')
        }
    })
})
