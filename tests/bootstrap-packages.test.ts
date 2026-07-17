import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { packerInstallScript } from '@/bootstrap/packages.ts'

describe('packerInstallScript', () => {
    test('is valid Bash and does not require lsb_release', () => {
        const result = spawnSync('bash', ['-n'], {
            input: packerInstallScript,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(packerInstallScript).toContain('. /etc/os-release')
        expect(packerInstallScript).not.toContain('lsb_release')
    })

    test('repairs the source file before running apt-get update', () => {
        const writeIndex = packerInstallScript.indexOf(
            'install -m 0644 "$tmpdir/hashicorp.list" "$repo_list"'
        )
        const finalUpdateIndex =
            packerInstallScript.lastIndexOf('apt-get update')
        expect(writeIndex).toBeGreaterThan(-1)
        expect(finalUpdateIndex).toBeGreaterThan(writeIndex)
    })
})
