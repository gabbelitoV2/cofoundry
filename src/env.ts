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

    CF_OUT_DIR: z.string().default('./out'),
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

    // Optional CDN integration. {{file}} and {{name}} placeholders.
    CF_UPLOAD_CMD: z.string().optional(),
    CF_PUBLIC_URL_TMPL: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export const loadEnv = (): Env => {
    const env = EnvSchema.parse(process.env)
    addSensitiveValues(env.PVE_TOKEN_ID, env.PVE_TOKEN_SECRET)
    return env
}
