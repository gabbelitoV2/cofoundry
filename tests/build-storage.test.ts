import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    assertShrinkStorageSupported,
    storageTypeCommand,
} from '@/build/storage.ts'

const env = { SSH_TARGET: 'root@node', CF_STORAGE: 'local-zfs' } as Env

const recipe = (name: string, finalDiskSize?: string): RecipeInfo =>
    ({ name, finalDiskSize }) as RecipeInfo

// Simulated `pvesm status` responder recording each remote command.
const execReturning = (
    output: string,
    commands: string[] = []
): ((target: string, cmd: string) => Promise<string>) => {
    return async (target, cmd) => {
        expect(target).toBe('root@node')
        commands.push(cmd)
        return output
    }
}

describe('storageTypeCommand', () => {
    test('queries pvesm and selects the type column by storage name', () => {
        const cmd = storageTypeCommand('local-zfs')
        expect(cmd).toContain("pvesm status --storage 'local-zfs'")
        expect(cmd).toContain("awk -v s='local-zfs'")
        expect(cmd).toContain('$1 == s { print $2; exit }')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('shell-quotes the storage name', () => {
        expect(storageTypeCommand("a'b")).toContain("'a'\\''b'")
    })
})

describe('assertShrinkStorageSupported', () => {
    test('skips the remote check when no recipe sets final_disk_size', async () => {
        const commands: string[] = []
        await assertShrinkStorageSupported(
            env,
            [recipe('debian-12'), recipe('rocky-linux-9')],
            execReturning('zfspool\n', commands)
        )
        expect(commands).toEqual([])
    })

    test('accepts dir storage for shrinking recipes', async () => {
        const commands: string[] = []
        await assertShrinkStorageSupported(
            env,
            [recipe('windows-server-2025', '32G')],
            execReturning('dir\n', commands)
        )
        expect(commands).toEqual([storageTypeCommand('local-zfs')])
    })

    test('accepts other file-backed storage types such as nfs', async () => {
        await assertShrinkStorageSupported(
            env,
            [recipe('windows-server-2025', '32G')],
            execReturning('nfs\n')
        )
    })

    test('rejects block/dataset storage with an actionable message', async () => {
        const err = await assertShrinkStorageSupported(
            env,
            [recipe('debian-12'), recipe('windows-server-2025', '32G')],
            execReturning('zfspool\n')
        ).then(
            () => undefined,
            (e: unknown) => e as Error
        )
        expect(err).toBeInstanceOf(Error)
        // Name the shrinking recipe, the storage, its type, and both ways out.
        expect(err?.message).toContain('windows-server-2025')
        expect(err?.message).not.toContain('debian-12')
        expect(err?.message).toContain('"local-zfs"')
        expect(err?.message).toContain('"zfspool"')
        expect(err?.message).toContain('dir-backed storage')
        expect(err?.message).toContain('remove final_disk_size')
    })

    test('rejects when the storage is not reported by pvesm status', async () => {
        await expect(
            assertShrinkStorageSupported(
                env,
                [recipe('windows-server-2025', '32G')],
                execReturning('\n')
            )
        ).rejects.toThrow('was not reported by `pvesm status`')
    })
})
