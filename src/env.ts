import { z } from 'zod'
import { addSensitiveValues } from '@/util.ts'

// CI passes unset secrets/vars as empty strings, which would defeat
// `.default(...)` (Zod only applies defaults when the value is undefined).
// Strip empty-string values before parsing so defaults engage.
const stripEmpty = (input: NodeJS.ProcessEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
        if (v !== '') out[k] = v
    }
    return out
}

const EnvSchema = z.object({
    PVE_HOST: z.string().min(1),
    PVE_PORT: z.coerce.number().int().default(8006),
    PVE_NODE: z.string().min(1),
    PVE_TOKEN_ID: z.string().min(1),
    PVE_TOKEN_SECRET: z.string().min(1),

    SSH_TARGET: z.string().min(1),
    PVE_DUMP_DIR: z.string().default('/var/lib/vz/dump'),

    CF_OUT_DIR: z.string().default('./dist'),
    CF_SKIP_ARTIFACT_SYNC: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),
    // Bridge for cloud-image recipes (DHCP via guest agent).
    CF_BRIDGE: z.string().default('vmbr0'),
    // NAT bridge for ISO-installer + Windows builds. Per-build dnsmasq
    // reservations are written under /etc/dnsmasq.d/cofoundry-slot-*.conf.
    CF_BUILD_BRIDGE: z.string().default('vmbr1'),
    CF_STORAGE: z.string().default('local'),
    CF_ISO_STORAGE: z.string().default('local'),

    // DNS resolver for ISO-installer build VMs. The IP and gateway are now
    // allocated per-build from the vmbr1 NAT pool (see src/build/netslot.ts),
    // so they no longer need static config.
    CF_BUILD_DNS: z.string().default('1.1.1.1'),

    // Parallel SFTP connections for syncing the repo up to the node (default 8).
    CF_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(8),

    // Parallel SFTP connections for syncing artifacts back down (default 8).
    CF_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(8),

    // Packer build admission limits. Parallel builds are opt-in and require
    // both resource budgets so the node cannot be oversubscribed accidentally.
    CF_BUILD_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    CF_BUILD_MEMORY_BUDGET_MB: z.coerce.number().int().min(1).optional(),
    CF_BUILD_CPU_BUDGET: z.coerce.number().int().min(1).optional(),

    // If set, skip destroying the build VM on abort (useful for debugging failed builds).
    CF_KEEP_VM: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),
    CF_BUILD_ATTEMPTS: z.coerce.number().int().min(1).optional(),

    // Optional CDN integration. Generated from [upload] in cofoundry.toml.
    CF_UPLOAD_CMD: z.string().optional(),
    CF_SIDECAR_UPLOAD_CMD: z.string().optional(),
    CF_PUBLIC_URL_TMPL: z.string().optional(),

    R2_ENDPOINT: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PREFIX: z.string().default('templates/'),
})

export type Env = z.infer<typeof EnvSchema>

export const loadEnv = (): Env => {
    const env = EnvSchema.parse(stripEmpty(process.env))
    addSensitiveValues(
        env.PVE_TOKEN_ID,
        env.PVE_TOKEN_SECRET,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_SESSION_TOKEN
    )
    return env
}

// Relaxed loader for `cf bootstrap` — only SSH_TARGET is needed (and even that
// can be prompted for). Used before PVE_TOKEN_* exist, since bootstrap is what
// produces them.
const PartialEnvSchema = EnvSchema.partial()
export type PartialEnv = z.infer<typeof PartialEnvSchema>

export const loadEnvPartial = (): PartialEnv => {
    const env = PartialEnvSchema.parse(stripEmpty(process.env))
    addSensitiveValues(
        env.PVE_TOKEN_ID,
        env.PVE_TOKEN_SECRET,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_SESSION_TOKEN
    )
    return env
}
