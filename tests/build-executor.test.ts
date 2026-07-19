import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { buildWritableRepoCommand } from '@/build/executor.ts'
import { destroyVmCommand } from '@/build/vm.ts'

describe('buildWritableRepoCommand', () => {
    test('dereferences the stable snapshot into a writable build copy', () => {
        const command = buildWritableRepoCommand(
            '/dump/cofoundry-work',
            '/dump/cofoundry-tmp/build-debian/repo'
        )

        expect(command).toContain(
            "cp -aL '/dump/cofoundry-work' '/dump/cofoundry-tmp/build-debian/repo'"
        )
        expect(command).toContain(
            "chmod -R u+w '/dump/cofoundry-tmp/build-debian/repo'"
        )
    })

    test('copies cached Windows media into only the build copy', () => {
        // The cache filename carries the pinned version; the copy in the build
        // repo keeps the version-less name the recipes reference.
        const command = buildWritableRepoCommand(
            '/dump/cofoundry-work',
            '/dump/cofoundry-tmp/build-windows/repo',
            '/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi'
        )

        expect(command).toContain(
            "install -m 0644 '/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi' '/dump/cofoundry-tmp/build-windows/repo/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
        expect(command).not.toContain(
            "'/dump/cofoundry-work/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
    })
})

describe('destroyVmCommand', () => {
    test('reclaims only orphaned volumes belonging to the destroyed VMID', () => {
        const command = destroyVmCommand(400100, 'local-lvm')
        expect(command).toContain("pvesm list 'local-lvm'")
        expect(command).toContain('$NF==vmid')
        expect(command).toContain('pvesm free "$volid"')
        expect(command).toContain('! qm config 400100')
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})
