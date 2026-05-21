import type { Env } from '../env.ts'
import type { RecipeInfo } from '../config.ts'
import { shellQuote } from '../util.ts'

export const buildRemoteOutDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-out`

export const buildRemoteWorkDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-work`

export const buildRemoteTmpDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-tmp`

export const buildPackerVars = (
    env: Env,
    recipe: RecipeInfo,
    needsStaticIp: boolean,
    buildBridge: string,
    buildGw: string
): string[] => {
    const apiUrl = `https://${env.PVE_HOST}:${env.PVE_PORT}/api2/json`
    const vars = [
        '-var',
        `proxmox_api_url=${apiUrl}`,
        '-var',
        `proxmox_username=${env.PVE_TOKEN_ID}`,
        '-var',
        `proxmox_token=${env.PVE_TOKEN_SECRET}`,
        '-var',
        `proxmox_node=${env.PVE_NODE}`,
        '-var',
        `proxmox_storage_pool=${env.CF_STORAGE}`,
        '-var',
        `proxmox_iso_storage_pool=${env.CF_ISO_STORAGE}`,
        '-var',
        `proxmox_bridge=${buildBridge}`,
    ]
    if (needsStaticIp) {
        vars.push(
            '-var',
            `build_ip=${env.CF_BUILD_IP ?? ''}`,
            '-var',
            `build_gw=${buildGw}`,
            '-var',
            `build_dns=${env.CF_BUILD_DNS}`
        )
    }
    return vars
}

export const buildRemoteEnv = (
    env: Env,
    remoteOutDir: string,
    remoteTmpDir: string,
    arch: string
): string => {
    // Packer runs on the PVE node, so SSH_TARGET=local tells the post-processor
    // to run vzdump directly instead of SSHing back to itself.
    const pairs: Record<string, string> = {
        SSH_TARGET: 'local',
        PVE_DUMP_DIR: env.PVE_DUMP_DIR,
        CF_OUT_DIR: remoteOutDir,
        CF_ARCH: arch,
        TMPDIR: remoteTmpDir,
        PACKER_CACHE_DIR: '/var/lib/vz/template/iso',
    }
    if (env.CF_UPLOAD_CMD) pairs.CF_UPLOAD_CMD = env.CF_UPLOAD_CMD
    if (env.CF_PUBLIC_URL_TMPL)
        pairs.CF_PUBLIC_URL_TMPL = env.CF_PUBLIC_URL_TMPL
    return Object.entries(pairs)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ')
}

export const selectBridge = (
    env: Env,
    recipeName: string,
    hasPreseed: boolean,
    hasAutoinstall: boolean,
    hasKickstart: boolean
): string => {
    // ISO installers need early boot networking before the guest agent is
    // available, so reuse the NAT bridge that already exists for Windows.
    if (
        recipeName.startsWith('windows-') ||
        hasPreseed ||
        hasAutoinstall ||
        hasKickstart
    ) {
        return env.CF_WIN_BRIDGE
    }
    return env.CF_BRIDGE
}
