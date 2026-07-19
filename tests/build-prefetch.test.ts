import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { assetFetchCommand } from '@/build/prefetch.ts'
import { isPermanentWgetExit } from '@/build/remote.ts'

describe('assetFetchCommand', () => {
    test('locks, validates, and atomically publishes to a stable temp file', () => {
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
        // Stable temp path (no $$ PID) so pRetry re-runs resume the same
        // partial rather than starting a fresh download each attempt.
        expect(command).toContain(".tmp'; ")
        expect(command).not.toContain('.$$')
        expect(command).toContain('sha256sum "$tmp"')
        expect(command).toContain('mv -f "$tmp"')
    })

    test('resumes an interrupted transfer instead of restarting from zero', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso'
        )
        // -c resumes the partial .tmp; without it wget re-pulls from byte 0.
        expect(command).toContain(' -c ')
        // No EXIT trap, or a failed attempt would delete the partial it must
        // leave behind for the next attempt to resume.
        expect(command).not.toContain('trap')
        expect(command).toContain('--tries=5')
        expect(command).toContain('--retry-connrefused')
        expect(command).toContain('--waitretry=5')
        // A stalled read must be detected and retried, not left to hang until
        // the whole attempt is lost near the end of a multi-GB transfer.
        expect(command).toContain('--read-timeout=60')
        expect(command).toContain('--timeout=30')
        // -nv (not -q) keeps wget's error/retry lines in the CI log so a failed
        // fetch is diagnosable; --show-progress still forces the transfer bar.
        expect(command).toContain('wget -nv --show-progress')
        expect(command).not.toContain('wget -q')
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
