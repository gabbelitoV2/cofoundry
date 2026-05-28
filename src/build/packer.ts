import type { Env } from '../env.ts'
import type { RecipeInfo } from '../config.ts'
import { shellQuote } from '../util.ts'

export const buildRemoteOutDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-out`

export const buildRemoteWorkDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-work`

export const buildRemoteTmpDir = (env: Env): string =>
    `${env.PVE_DUMP_DIR}/cofoundry-tmp`

export type BuildNet = {
    ip: string
    gw: string
    mac: string
}

export const buildPackerVars = (
    env: Env,
    _recipe: RecipeInfo,
    buildBridge: string,
    net: BuildNet | null
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
    if (net) {
        vars.push(
            '-var',
            `build_ip=${net.ip}`,
            '-var',
            `build_gw=${net.gw}`,
            '-var',
            `build_mac=${net.mac}`,
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
    arch: string,
    group: string
): string => {
    // Packer runs on the PVE node, so SSH_TARGET=local tells the post-processor
    // to run vzdump directly instead of SSHing back to itself.
    const pairs: Record<string, string> = {
        SSH_TARGET: 'local',
        PVE_DUMP_DIR: env.PVE_DUMP_DIR,
        CF_OUT_DIR: remoteOutDir,
        CF_ARCH: arch,
        CF_GROUP: group,
        TMPDIR: remoteTmpDir,
        PACKER_CACHE_DIR: '/var/lib/vz/template/iso',
    }
    if (env.CF_UPLOAD_CMD) pairs.CF_UPLOAD_CMD = env.CF_UPLOAD_CMD
    if (env.CF_PUBLIC_URL_TMPL)
        pairs.CF_PUBLIC_URL_TMPL = env.CF_PUBLIC_URL_TMPL
    // Forward S3-compatible creds (R2, AWS, MinIO, …) so a CF_UPLOAD_CMD using
    // `aws s3 cp` can authenticate on the node. Opt-in via the host env only.
    for (const k of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_DEFAULT_REGION',
    ]) {
        const v = process.env[k]
        if (v) pairs[k] = v
    }
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
