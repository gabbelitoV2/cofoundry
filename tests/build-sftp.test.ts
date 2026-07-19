import { describe, expect, test } from 'bun:test'
import { matchesExclude } from '../src/build/sftp.ts'

const excludes = [
    '.claude',
    '.env',
    '.sbx/tailscale.env',
    'node_modules',
    '*.log',
]

describe('matchesExclude', () => {
    test.each([
        '.env',
        '.claude/settings.local.json',
        '.sbx/tailscale.env',
        'packages/ui/node_modules/pkg/index.js',
        'logs/build.log',
    ])('excludes local-only path %s', path => {
        expect(matchesExclude(path, excludes)).toBe(true)
    })

    test.each([
        '.env.example',
        '.sbx/tailscale.env.example',
        'docs/build.log.md',
        'src/environment.ts',
    ])('keeps similarly named repository path %s', path => {
        expect(matchesExclude(path, excludes)).toBe(false)
    })
})
