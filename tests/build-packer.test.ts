import { describe, expect, test } from 'bun:test'
import { buildPackerVars, buildRemoteEnv } from '../src/build/packer.ts'
import type { RecipeInfo } from '../src/config.ts'
import type { Env } from '../src/env.ts'

const env: Env = {
    PVE_HOST: 'pve.example.com',
    PVE_PORT: 8006,
    PVE_NODE: 'pve1',
    PVE_TOKEN_ID: 'root@pam!builder',
    PVE_TOKEN_SECRET: 'secret',
    SSH_TARGET: 'root@pve.example.com',
    PVE_DUMP_DIR: '/var/lib/vz/dump',
    CF_OUT_DIR: './dist',
    CF_SKIP_ARTIFACT_SYNC: false,
    CF_BRIDGE: 'vmbr0',
    CF_BUILD_BRIDGE: 'vmbr1',
    CF_STORAGE: 'local-lvm',
    CF_ISO_STORAGE: 'local',
    CF_BUILD_DNS: '1.1.1.1',
    CF_DOWNLOAD_CONCURRENCY: 8,
    CF_KEEP_VM: false,
}

describe('buildRemoteEnv', () => {
    test('exports the recipe base VMID independently of the build slot VMID', () => {
        const result = buildRemoteEnv(
            env,
            '/var/lib/vz/dump/cofoundry-out',
            '/var/lib/vz/dump/cofoundry-tmp',
            'amd64',
            'linux',
            undefined,
            4001
        )

        expect(result).toContain("CF_RECIPE_BASE_VMID='4001'")
        expect(result).toContain("PKR_VAR_proxmox_username='root@pam!builder'")
        expect(result).toContain("PKR_VAR_proxmox_token='secret'")
    })

    test('leaves the base unset for plain callers that rely on CF_BUILT_VMID', () => {
        const result = buildRemoteEnv(
            env,
            '/var/lib/vz/dump/cofoundry-out',
            '/var/lib/vz/dump/cofoundry-tmp',
            'amd64',
            'linux'
        )

        expect(result).not.toContain('CF_RECIPE_BASE_VMID')
    })
})

describe('buildPackerVars', () => {
    test('never places Proxmox credentials in Packer arguments', () => {
        const args = buildPackerVars(
            env,
            {} as RecipeInfo,
            'vmbr1',
            null,
            400100
        )
        const commandLine = args.join(' ')

        expect(commandLine).not.toContain(env.PVE_TOKEN_ID)
        expect(commandLine).not.toContain(env.PVE_TOKEN_SECRET)
        expect(commandLine).not.toContain('proxmox_username')
        expect(commandLine).not.toContain('proxmox_token')
    })
})
