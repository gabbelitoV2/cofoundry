import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
    assetFetchCommand,
    cloudbaseInitMsiCachePath,
    cloudbaseInitMsiUrl,
    pinnedChecksum,
    virtioWinIsoFilename,
    virtioWinIsoUrl,
} from '@/build/prefetch.ts'
import { isPermanentWgetExit } from '@/build/remote.ts'
import {
    CLOUDBASE_INIT_DEFAULT_VERSION,
    VIRTIO_WIN_DEFAULT_VERSION,
} from '@/env.ts'

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

describe('assetFetchCommand with a pinned sha256', () => {
    const destination =
        '/var/lib/vz/template/iso/packer-virtio-win-0.1.285-1.iso'
    const command = assetFetchCommand(
        destination,
        'https://example.com/virtio-win.iso',
        {
            sha256: 'E14CF2B94492C3E925F0070BA7FDFEDEB2048C91EEA9C5A5AFB30232A3976331',
        }
    )

    test('validates the cached file and the fresh download against the pin', () => {
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(command).toContain(`sha256sum '${destination}'`)
        expect(command).toContain('sha256sum "$tmp"')
        // The pin is compared lowercased, once per validation site.
        const pin =
            "'e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331'"
        expect(command.split(pin).length - 1).toBe(2)
    })

    test('never degenerates to a non-empty check or a remote checksum fetch', () => {
        expect(command).not.toContain('test -s')
        expect(command).not.toContain('curl')
    })
})

describe('pinnedChecksum', () => {
    test('an explicit override wins regardless of version', () => {
        expect(pinnedChecksum('abc123', '9.9.9', '1.1.8', 'def456')).toEqual({
            sha256: 'abc123',
        })
    })

    test('the built-in pin applies only to the default version', () => {
        expect(pinnedChecksum(undefined, '1.1.8', '1.1.8', 'def456')).toEqual({
            sha256: 'def456',
        })
        // A bumped version without an explicit pin must not be validated
        // against the default version's hash — that would always fail.
        expect(
            pinnedChecksum(undefined, '9.9.9', '1.1.8', 'def456')
        ).toBeUndefined()
    })
})

describe('pinned Windows asset locations', () => {
    test('cloudbase-init resolves to the versioned GitHub release, not latest', () => {
        expect(cloudbaseInitMsiUrl(CLOUDBASE_INIT_DEFAULT_VERSION)).toBe(
            `https://github.com/cloudbase/cloudbase-init/releases/download/${CLOUDBASE_INIT_DEFAULT_VERSION}/CloudbaseInitSetup_${CLOUDBASE_INIT_DEFAULT_VERSION.replace(/\./g, '_')}_x64.msi`
        )
        expect(
            cloudbaseInitMsiUrl(CLOUDBASE_INIT_DEFAULT_VERSION)
        ).not.toContain('latest')
    })

    test('virtio-win resolves to the versioned archive, not stable-virtio', () => {
        expect(virtioWinIsoUrl(VIRTIO_WIN_DEFAULT_VERSION)).toBe(
            `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-${VIRTIO_WIN_DEFAULT_VERSION}/virtio-win.iso`
        )
        expect(virtioWinIsoUrl(VIRTIO_WIN_DEFAULT_VERSION)).not.toContain(
            'stable-virtio'
        )
    })

    test('cache filenames include the version so a bump refetches', () => {
        expect(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.8',
            })
        ).toBe('/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi')
        expect(
            virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.285-1' })
        ).toBe('packer-virtio-win-0.1.285-1.iso')
        expect(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.9',
            })
        ).not.toBe(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.8',
            })
        )
        expect(
            virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.271-1' })
        ).not.toBe(virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.285-1' }))
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
