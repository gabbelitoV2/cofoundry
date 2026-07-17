import { describe, expect, test } from 'bun:test'
import { buildWritableRepoCommand } from '@/build/executor.ts'

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
        const command = buildWritableRepoCommand(
            '/dump/cofoundry-work',
            '/dump/cofoundry-tmp/build-windows/repo',
            '/dump/cofoundry-cache/CloudbaseInitSetup_x64.msi'
        )

        expect(command).toContain(
            "install -m 0644 '/dump/cofoundry-cache/CloudbaseInitSetup_x64.msi' '/dump/cofoundry-tmp/build-windows/repo/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
        expect(command).not.toContain(
            "'/dump/cofoundry-work/recipes/_shared/CloudbaseInitSetup_x64.msi'"
        )
    })
})
