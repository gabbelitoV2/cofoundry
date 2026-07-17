export type ConfigSource =
    | 'env'
    | 'local'
    | 'toml'
    | 'derived'
    | 'default'
    | 'unset'

export type ResolvedValue = {
    key: string
    value?: string
    source: ConfigSource
    detail?: string
}

export const FIELD_MAP: readonly (readonly [string, string])[] = [
    ['node.host', 'PVE_HOST'],
    ['node.node', 'PVE_NODE'],
    ['node.port', 'PVE_PORT'],
    ['node.ssh', 'SSH_TARGET'],
    ['node.token_id', 'PVE_TOKEN_ID'],
    ['node.dump_dir', 'PVE_DUMP_DIR'],
    ['storage.disks', 'CF_STORAGE'],
    ['storage.isos', 'CF_ISO_STORAGE'],
    ['network.bridge', 'CF_BRIDGE'],
    ['network.build_bridge', 'CF_BUILD_BRIDGE'],
    ['network.build_dns', 'CF_BUILD_DNS'],
    ['upload.endpoint', 'R2_ENDPOINT'],
    ['upload.bucket', 'R2_BUCKET'],
    ['upload.prefix', 'R2_PREFIX'],
    ['build.attempts', 'CF_BUILD_ATTEMPTS'],
    ['build.upload_concurrency', 'CF_UPLOAD_CONCURRENCY'],
    ['build.download_concurrency', 'CF_DOWNLOAD_CONCURRENCY'],
    ['local.out_dir', 'CF_OUT_DIR'],
]

export const CONFIG_DEFAULTS: Readonly<Record<string, string>> = {
    PVE_PORT: '8006',
    PVE_DUMP_DIR: '/var/lib/vz/dump',
    CF_STORAGE: 'local',
    CF_ISO_STORAGE: 'local',
    CF_BRIDGE: 'vmbr0',
    CF_BUILD_BRIDGE: 'vmbr1',
    CF_BUILD_DNS: '1.1.1.1',
    CF_UPLOAD_CONCURRENCY: '8',
    CF_DOWNLOAD_CONCURRENCY: '8',
    CF_OUT_DIR: './dist',
}

export const CONFIG_FILENAME = 'cofoundry.toml'
export const CONFIG_LOCAL_FILENAME = 'cofoundry.local.toml'
