import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { assetFetchCommand } from '@/build/prefetch.ts'
import { isPermanentWgetExit } from '@/build/remote.ts'

describe('assetFetchCommand', () => {
    test('locks, validates, and atomically publishes a unique temp file', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso',
            {
                url: 'https://example.com/SHA256SUMS',
                filenamePattern: 'debian-.*\\.iso',
            }
        )
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(command).toContain('flock -x 9')
        expect(command).toContain(".tmp'.$$")
        expect(command).toContain('sha256sum "$tmp"')
        expect(command).toContain('mv -f "$tmp"')
    })

    test('lets wget resume a stalled or refused transfer before giving up', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso'
        )
        expect(command).toContain('--tries=3')
        expect(command).toContain('--retry-connrefused')
        expect(command).toContain('--waitretry=5')
    })
})

describe('isPermanentWgetExit', () => {
    test('treats a stale URL (8) and a bad invocation (2) as permanent', () => {
        expect(isPermanentWgetExit(8)).toBe(true)
        expect(isPermanentWgetExit(2)).toBe(true)
    })

    test('treats network/generic faults as retryable', () => {
        for (const code of [1, 3, 4, 5, 7])
            expect(isPermanentWgetExit(code)).toBe(false)
    })
})
