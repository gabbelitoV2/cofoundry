import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
    MAINTENANCE_LOCK,
    maintenanceLockCommand,
} from '@/build/maintenance.ts'

describe('maintenanceLockCommand', () => {
    test('keeps builds parallel under a shared node lock', () => {
        const cmd = maintenanceLockCommand('shared')
        expect(cmd).toContain(`flock -s '${MAINTENANCE_LOCK}'`)
        expect(cmd).toContain('cat >/dev/null')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('serializes destructive cleanup with an exclusive node lock', () => {
        expect(maintenanceLockCommand('exclusive')).toContain(
            `flock -x '${MAINTENANCE_LOCK}'`
        )
    })
})
