import type { Command } from 'commander'
import pc from 'picocolors'
import { runDoctor, runInit } from '@/config-init.ts'
import type { ResolvedValue } from '@/config-file.ts'
import { log } from '@/log.ts'
import { redactSensitive } from '@/util.ts'

const SECRET_KEYS = [
    'PVE_TOKEN_SECRET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
] as const

const SOURCE_COLOR: Record<ResolvedValue['source'], (s: string) => string> = {
    env: pc.green,
    local: pc.yellow,
    toml: pc.cyan,
    derived: pc.magenta,
    default: pc.dim,
    unset: pc.dim,
}

const showConfig = (
    resolution: ResolvedValue[],
    opts: { json?: boolean }
): void => {
    const secrets = SECRET_KEYS.map(key => ({
        key,
        set: Boolean(process.env[key]),
    }))
    if (opts.json) {
        const config = resolution.map(value => ({
            ...value,
            value:
                value.value === undefined
                    ? undefined
                    : redactSensitive(value.value),
        }))
        console.log(JSON.stringify({ config, secrets }, null, 2))
        return
    }

    if (resolution.length === 0) {
        log.warn(
            `No ${pc.cyan('cofoundry.toml')} found — using env vars and defaults only.`
        )
        log.note(`Run ${pc.cyan('cf init')} to scaffold one.`)
        log.blank()
    }
    log.section('Resolved config')
    const width = Math.max(...resolution.map(value => value.key.length), 12)
    for (const value of resolution) {
        const rendered =
            value.value === undefined
                ? pc.dim('(unset)')
                : redactSensitive(value.value)
        const detail = value.detail ? pc.dim(`  ← ${value.detail}`) : ''
        log.raw(
            `  ${pc.bold(value.key.padEnd(width))}  ${rendered}  ${SOURCE_COLOR[value.source](`[${value.source}]`)}${detail}`
        )
    }
    log.blank()
    log.section('Secrets (env-only)')
    for (const secret of secrets) {
        log.raw(
            `  ${pc.bold(secret.key.padEnd(width))}  ${secret.set ? pc.green('set') : pc.dim('unset')}`
        )
    }
    log.blank()
}

export const registerConfigCommands = (
    program: Command,
    resolution: ResolvedValue[]
): void => {
    program
        .command('config')
        .description(
            'Show the resolved configuration and where each value comes from'
        )
        .option('--json', 'Output as JSON')
        .action((opts: { json?: boolean }) => showConfig(resolution, opts))

    program
        .command('init')
        .description('Scaffold a cofoundry.toml config file')
        .option(
            '--from-env',
            'Fill non-sensitive values from the current environment'
        )
        .option('--force', 'Overwrite an existing cofoundry.toml')
        .action((opts: { fromEnv?: boolean; force?: boolean }) => runInit(opts))

    program
        .command('doctor')
        .description('Preflight connectivity checks (SSH, PVE API, R2)')
        .action(runDoctor)
}
