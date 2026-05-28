import { z } from 'zod'
import { addSensitiveValues } from './util.ts'

const EnvSchema = z.object({
    PVE_HOST: z.string().min(1),
    PVE_PORT: z.coerce.number().int().default(8006),
    PVE_NODE: z.string().min(1),
    PVE_TOKEN_ID: z.string().min(1),
    PVE_TOKEN_SECRET: z.string().min(1),

    SSH_TARGET: z.string().min(1),
    PVE_DUMP_DIR: z.string().default('/var/lib/vz/dump'),

    CF_OUT_DIR: z.string().default('./dist'),
    CF_SKIP_SYNC_BACK: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),
    CF_BRIDGE: z.string().default('vmbr0'),
    CF_WIN_BRIDGE: z.string().default('vmbr1'),
    CF_STORAGE: z.string().default('local'),
    CF_ISO_STORAGE: z.string().default('local'),

    // Static network config for preseed-based build VMs (e.g. debian-12).
    // The build VM cannot use DHCP, so these must be set for ISO installer builds.
    CF_BUILD_IP: z.string().optional(),
    CF_BUILD_GW: z.string().optional(),
    CF_BUILD_DNS: z.string().default('1.1.1.1'),

    // Parallel SFTP connections for syncing the repo up to the node (default 8).
    CF_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(8),

    // Parallel SFTP connections for syncing artifacts back down (default 8).
    CF_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(8),

    // If set, skip destroying the build VM on abort (useful for debugging failed builds).
    CF_KEEP_VM: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),

    // Optional CDN integration. {{file}} and {{name}} placeholders.
    CF_UPLOAD_CMD: z.string().optional(),
    CF_PUBLIC_URL_TMPL: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export const loadEnv = (): Env => {
    const env = EnvSchema.parse(process.env)
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
    const env = PartialEnvSchema.parse(process.env)
    addSensitiveValues(
        env.PVE_TOKEN_ID,
        env.PVE_TOKEN_SECRET,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_SESSION_TOKEN
    )
    return env
}
