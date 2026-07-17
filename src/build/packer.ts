import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'

export type BuildNet = {
    ip: string
    gw: string
    mac: string
}

export const buildPackerVars = (
    env: Env,
    _recipe: RecipeInfo,
    buildBridge: string,
    net: BuildNet | null,
    buildVmid?: number
): string[] => {
    const apiUrl = `https://${env.PVE_HOST}:${env.PVE_PORT}/api2/json`
    const vars = [
        '-var',
        `proxmox_api_url=${apiUrl}`,
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
    if (buildVmid !== undefined) {
        vars.push('-var', `build_vmid=${buildVmid}`)
    }
    return vars
}

export const buildRemoteEnv = (
    env: Env,
    remoteOutDir: string,
    remoteTmpDir: string,
    arch: string,
    group: string,
    finalDiskSize?: string,
    baseVmid?: number
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
        // Packer automatically maps Packer variable names from PKR_VAR_*.
        // These stay in the remote process environment instead of appearing
        // in the Packer argv/process listing.
        PKR_VAR_proxmox_username: env.PVE_TOKEN_ID,
        PKR_VAR_proxmox_token: env.PVE_TOKEN_SECRET,
    }
    // The post-processor's CF_BUILT_VMID is the slot-derived id (base*100+slot)
    // for parallel builds; export the recipe BASE so downstream consumers
    // (e.g. cf-cluster-templates.sh) get it directly instead of reverse-
    // engineering it. Inherited by the shell-local post-processor and any
    // CF_UPLOAD_CMD it spawns.
    if (baseVmid !== undefined) pairs.CF_RECIPE_BASE_VMID = String(baseVmid)
    // Opt-in: when set, the post-processor shrinks the OS disk to this size
    // before vzdump (see builds/_shared/post/shrink-disk.sh).
    if (finalDiskSize) pairs.CF_FINAL_DISK_SIZE = finalDiskSize
    if (env.CF_UPLOAD_CMD) pairs.CF_UPLOAD_CMD = env.CF_UPLOAD_CMD
    if (env.CF_SIDECAR_UPLOAD_CMD)
        pairs.CF_SIDECAR_UPLOAD_CMD = env.CF_SIDECAR_UPLOAD_CMD
    if (env.CF_PUBLIC_URL_TMPL)
        pairs.CF_PUBLIC_URL_TMPL = env.CF_PUBLIC_URL_TMPL
    if (env.R2_ENDPOINT) pairs.R2_ENDPOINT = env.R2_ENDPOINT
    if (env.R2_BUCKET) pairs.R2_BUCKET = env.R2_BUCKET
    if (env.R2_PREFIX) pairs.R2_PREFIX = env.R2_PREFIX
    // Forward S3-compatible creds + endpoint/bucket so a CF_UPLOAD_CMD using
    // `aws s3 cp ... $R2_ENDPOINT ... s3://$R2_BUCKET/...` can authenticate
    // and resolve those shell vars on the node.
    for (const k of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_DEFAULT_REGION',
    ]) {
        const v = process.env[k]
        if (v) pairs[k] = v
    }
    // R2 rejects the default CRC32 integrity checksum AWS CLI v2.23+ adds to
    // single-part PutObject ("SignatureDoesNotMatch" on small objects like
    // sidecar JSONs). Multipart uploads (large .vma.zst) take a different
    // code path and aren't affected. Caller can override by exporting these.
    pairs.AWS_REQUEST_CHECKSUM_CALCULATION =
        process.env.AWS_REQUEST_CHECKSUM_CALCULATION ?? 'when_required'
    pairs.AWS_RESPONSE_CHECKSUM_VALIDATION =
        process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ?? 'when_required'
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
    // ISO installers + Windows can't use guest-agent IP discovery, so they run
    // on the NAT bridge with a per-build dnsmasq reservation (see netslot.ts).
    if (
        recipeName.startsWith('windows-') ||
        hasPreseed ||
        hasAutoinstall ||
        hasKickstart
    ) {
        return env.CF_BUILD_BRIDGE
    }
    return env.CF_BRIDGE
}
