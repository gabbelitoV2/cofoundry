import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { log } from '@/log.ts'
import { CONFIG_FILENAME, CONFIG_LOCAL_FILENAME } from '@/config-file.ts'
import pc from 'picocolors'

// Sensitive coordinates are never inlined by `cf init --from-env` — they stay as
// ${VAR} so a committed cofoundry.toml doesn't leak the node address or R2
// account id into a public repo. Everything else is safe to inline.
const SENSITIVE = new Set(['PVE_HOST', 'SSH_TARGET', 'R2_ENDPOINT'])

const val = (key: string, fromEnv: boolean, fallback: string): string => {
    if (SENSITIVE.has(key)) return `\${${key}}`
    if (fromEnv && process.env[key]) return process.env[key] as string
    return fallback
}

// Derive the public URL *base* from a legacy CF_PUBLIC_URL_TMPL by cutting at
// the first placeholder segment: ".../host.com/{{name}}/..." → ".../host.com".
const publicBase = (fromEnv: boolean): string => {
    const tmpl = fromEnv ? process.env.CF_PUBLIC_URL_TMPL : undefined
    if (!tmpl) return 'https://templates.example.com'
    return tmpl.split(/\/?\{\{/)[0]!.replace(/\/+$/, '')
}

const renderTemplate = (fromEnv: boolean): string => {
    const q = (s: string) => `"${s}"`
    const attempts =
        fromEnv && process.env.CF_BUILD_ATTEMPTS
            ? `attempts = ${process.env.CF_BUILD_ATTEMPTS}`
            : '# attempts = 3   # optional global override; defaults to 3 for Windows, 1 otherwise'
    const memoryBudget =
        fromEnv && process.env.CF_BUILD_MEMORY_BUDGET_MB
            ? `memory_budget_mb = ${process.env.CF_BUILD_MEMORY_BUDGET_MB}`
            : '# memory_budget_mb = 16384  # required when concurrency > 1'
    const cpuBudget =
        fromEnv && process.env.CF_BUILD_CPU_BUDGET
            ? `cpu_budget = ${process.env.CF_BUILD_CPU_BUDGET}`
            : '# cpu_budget = 8             # required when concurrency > 1'
    return `# cofoundry.toml — non-secret deployment config for \`cf\`.
# Committed and reviewable. Inspect the resolved result with \`cf config\`.
#
# Secrets (PVE_TOKEN_SECRET, AWS_*) come from the environment, never here.
# Sensitive coordinates use \${VAR} so they stay out of a public repo; a
# gitignored ${CONFIG_LOCAL_FILENAME} can override any value per machine.
# Resolution order: flag > env > \${VAR} > ${CONFIG_LOCAL_FILENAME} > this file > default.

[node]
host     = ${q(val('PVE_HOST', fromEnv, '${PVE_HOST}'))}      # sensitive → from env
ssh      = ${q(val('SSH_TARGET', fromEnv, '${SSH_TARGET}'))}    # sensitive → from env
node     = ${q(val('PVE_NODE', fromEnv, 'pve'))}
token_id = ${q(val('PVE_TOKEN_ID', fromEnv, 'root@pam!cofoundry'))}
port     = ${val('PVE_PORT', fromEnv, '8006')}
dump_dir = ${q(val('PVE_DUMP_DIR', fromEnv, '/var/lib/vz/dump'))}

[storage]
disks = ${q(val('CF_STORAGE', fromEnv, 'local'))}
isos  = ${q(val('CF_ISO_STORAGE', fromEnv, 'local'))}

[network]
bridge       = ${q(val('CF_BRIDGE', fromEnv, 'vmbr0'))}   # direct-network builds
build_bridge = ${q(val('CF_BUILD_BRIDGE', fromEnv, 'vmbr1'))}   # ISO-installer + Windows NAT bridge
build_dns    = ${q(val('CF_BUILD_DNS', fromEnv, '1.1.1.1'))}

[upload]
# Object key is generated from \`layout\` (grouped|flat). For a custom path set
#   key = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"
# Placeholders: {{recipe}} {{arch}} {{group}} {{sha256}}.
endpoint   = ${q(val('R2_ENDPOINT', fromEnv, '${R2_ENDPOINT}'))}   # sensitive (account id) → from env
bucket     = ${q(val('R2_BUCKET', fromEnv, 'cofoundry-templates'))}
layout     = "grouped"   # templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}
public_url = ${q(publicBase(fromEnv))}
prefix     = ${q(val('R2_PREFIX', fromEnv, 'templates/'))}   # what \`cf publish --r2\` scans

[build]
${attempts}
concurrency          = ${val('CF_BUILD_CONCURRENCY', fromEnv, '1')}
${memoryBudget}
${cpuBudget}
upload_concurrency   = ${val('CF_UPLOAD_CONCURRENCY', fromEnv, '8')}
download_concurrency = ${val('CF_DOWNLOAD_CONCURRENCY', fromEnv, '8')}

[local]
out_dir = ${q(val('CF_OUT_DIR', fromEnv, './dist'))}
`
}

export interface InitOptions {
    fromEnv?: boolean
    force?: boolean
}

export const runInit = (
    opts: InitOptions,
    cwd: string = process.cwd()
): void => {
    const path = join(cwd, CONFIG_FILENAME)
    if (existsSync(path) && !opts.force) {
        throw new Error(
            `${CONFIG_FILENAME} already exists. Pass ${pc.cyan('--force')} to overwrite.`
        )
    }
    writeFileSync(path, renderTemplate(Boolean(opts.fromEnv)))
    log.ok(`Wrote ${pc.cyan(CONFIG_FILENAME)}.`)
    if (opts.fromEnv) {
        log.note(
            'Filled from current env. Review it, then move any private values you '
        )
        log.note(
            `don't want committed into ${pc.cyan(CONFIG_LOCAL_FILENAME)} (gitignored).`
        )
    }
    log.note(`Verify with ${pc.cyan('cf config')} and ${pc.cyan('cf doctor')}.`)
    log.blank()
}

// ── cf doctor ──────────────────────────────────────────────────────────────
// Preflight connectivity: SSH to the node, PVE API auth, R2 credentials.
// Reads the already-resolved process.env (config file was seeded at startup).

interface Check {
    label: string
    run: () => Promise<{ ok: boolean; detail: string }>
    skip?: string
}

const checkSsh = async (): Promise<{ ok: boolean; detail: string }> => {
    const target = process.env.SSH_TARGET
    if (!target) return { ok: false, detail: 'SSH_TARGET unset' }
    try {
        await execa(
            'ssh',
            [
                '-o',
                'BatchMode=yes',
                '-o',
                'ConnectTimeout=8',
                '-o',
                'StrictHostKeyChecking=accept-new',
                target,
                'true',
            ],
            { timeout: 12_000 }
        )
        return { ok: true, detail: target }
    } catch (err) {
        return {
            ok: false,
            detail:
                err instanceof Error ? err.message.split('\n')[0]! : 'failed',
        }
    }
}

const checkPve = async (): Promise<{ ok: boolean; detail: string }> => {
    const { PVE_HOST, PVE_PORT, PVE_TOKEN_ID, PVE_TOKEN_SECRET } = process.env
    if (!PVE_HOST || !PVE_TOKEN_ID || !PVE_TOKEN_SECRET)
        return { ok: false, detail: 'PVE_HOST / PVE_TOKEN_* unset' }
    const url = `https://${PVE_HOST}:${PVE_PORT ?? 8006}/api2/json/version`
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: `PVEAPIToken=${PVE_TOKEN_ID}=${PVE_TOKEN_SECRET}`,
            },
            // Proxmox uses a self-signed cert by default.
            tls: { rejectUnauthorized: false },
            signal: AbortSignal.timeout(8000),
        } as RequestInit)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
        const body = (await res.json()) as { data?: { version?: string } }
        return { ok: true, detail: `pve ${body.data?.version ?? '?'}` }
    } catch (err) {
        return {
            ok: false,
            detail:
                err instanceof Error ? err.message.split('\n')[0]! : 'failed',
        }
    }
}

const checkR2 = async (): Promise<{ ok: boolean; detail: string }> => {
    const { R2_ENDPOINT, R2_BUCKET } = process.env
    try {
        await execa(
            'aws',
            [
                '--endpoint-url',
                R2_ENDPOINT!,
                's3api',
                'head-bucket',
                '--bucket',
                R2_BUCKET!,
            ],
            { timeout: 15_000 }
        )
        return { ok: true, detail: `s3://${R2_BUCKET}` }
    } catch (err) {
        return {
            ok: false,
            detail:
                err instanceof Error ? err.message.split('\n')[0]! : 'failed',
        }
    }
}

export const runDoctor = async (): Promise<void> => {
    const r2Values = [process.env.R2_ENDPOINT, process.env.R2_BUCKET]
    const r2Configured = r2Values.every(Boolean)
    const r2PartiallyConfigured = r2Values.some(Boolean) && !r2Configured
    const checks: Check[] = [
        { label: 'SSH to node', run: checkSsh },
        { label: 'PVE API auth', run: checkPve },
        {
            label: 'R2 credentials',
            run: r2PartiallyConfigured
                ? async () => ({
                      ok: false,
                      detail: 'R2_ENDPOINT / R2_BUCKET incomplete',
                  })
                : checkR2,
            skip:
                !r2Configured && !r2PartiallyConfigured
                    ? 'no R2 config'
                    : undefined,
        },
    ]

    log.section('Doctor')
    let failed = 0
    for (const c of checks) {
        if (c.skip) {
            log.raw(`  ${pc.dim('○')} ${c.label.padEnd(16)} ${pc.dim(c.skip)}`)
            continue
        }
        const { ok, detail } = await c.run()
        if (!ok) failed++
        const mark = ok ? pc.green('✓') : pc.red('✗')
        const tail = ok ? pc.dim(detail) : pc.red(detail)
        log.raw(`  ${mark} ${c.label.padEnd(16)} ${tail}`)
    }
    log.blank()
    if (failed > 0) {
        throw new Error(`${failed} check(s) failed.`)
    }
    log.ok('All checks passed.')
    log.blank()
}
