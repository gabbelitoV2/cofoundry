import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { assetFetchCommand } from '@/build/prefetch.ts'

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
})
