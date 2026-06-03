import { Command } from 'commander'
import logUpdate from 'log-update'
import pc from 'picocolors'
import { resolveConfig } from './config.ts'
import { fetchRegistry } from './registry.ts'
import { resolveVmids } from './vmid.ts'
import {
    downloadWithRetry,
    verifySha256,
    ensureTempDir,
    tempPath,
} from './download.ts'
import { qmrestore } from './install.ts'
import {
    promptStorage,
    promptTemplateSelection,
    confirmVmidConflicts,
} from './prompt.ts'
import { log } from './log.ts'
import type { Template } from '../../src/registry/schema.ts'

type ProgressPhase =
    | 'queued'
    | 'download'
    | 'verify'
    | 'install'
    | 'done'
    | 'failed'

interface ProgressRow {
    name: string
    phase: ProgressPhase
    pct: number
    message?: string
}

class ProgressRenderer {
    private rows = new Map<string, ProgressRow>()
    private lastLog = new Map<string, number>()
    private readonly enabled = process.stdout.isTTY

    constructor(names: string[]) {
        for (const name of names) {
            this.rows.set(name, { name, phase: 'queued', pct: 0 })
        }
    }

    update(
        name: string,
        phase: ProgressPhase,
        pct: number,
        message?: string
    ): void {
        const row = this.rows.get(name) ?? { name, phase, pct: 0 }
        const clamped = Math.max(0, Math.min(100, pct))
        if (
            row.phase === phase &&
            row.pct === clamped &&
            row.message === message
        )
            return

        row.phase = phase
        row.pct = clamped
        row.message = message
        this.rows.set(name, row)

        if (!this.enabled) {
            this.logSparse(row)
            return
        }

        this.render()
    }

    finish(): void {
        if (this.enabled) logUpdate.done()
    }

    private logSparse(row: ProgressRow): void {
        const key = `${row.name}:${row.phase}`
        const last = this.lastLog.get(key) ?? -1
        if (row.pct !== 100 && row.pct % 10 !== 0) return
        if (row.pct === last) return
        this.lastLog.set(key, row.pct)
        log.info(
            `${row.name}: ${row.phase} ${row.pct}%${row.message ? ` — ${row.message}` : ''}`
        )
    }

    private render(): void {
        const lines = [pc.bold('Installing templates')]
        for (const row of this.rows.values()) {
            lines.push(this.formatRow(row))
        }

        logUpdate(lines.join('\n'))
    }

    private formatRow(row: ProgressRow): string {
        const label = row.name.padEnd(28)
        const phase = row.phase.padEnd(8)
        const pct = String(row.pct).padStart(3)
        const width = 24
        const filled = Math.round((row.pct / 100) * width)
        const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`
        const text = row.message ? `  ${pc.dim(row.message)}` : ''

        if (row.phase === 'done') {
            return `  ${pc.green('OK')} ${label} ${phase} [${bar}] ${pct}%${text}`
        }
        if (row.phase === 'failed') {
            return `  ${pc.red('!!')} ${label} ${phase} [${bar}] ${pct}%${text}`
        }
        if (row.phase === 'queued') {
            return `  ${pc.dim('--')} ${label} ${pc.dim(phase)} [${bar}] ${pct}%${text}`
        }
        return `  ${pc.cyan('>>')} ${label} ${phase} [${bar}] ${pct}%${text}`
    }
}

const installTemplate = async (
    template: Template,
    vmid: number,
    storage: string,
    verify: boolean,
    force: boolean,
    progress: ProgressRenderer
): Promise<void> => {
    const dest = tempPath(vmid)

    progress.update(template.name, 'download', 0)
    await downloadWithRetry(template.url, dest, pct =>
        progress.update(template.name, 'download', pct)
    )

    if (verify) {
        progress.update(template.name, 'verify', 0)
        await verifySha256(dest, template.sha256)
    }

    progress.update(template.name, 'install', 0, `VMID ${vmid}`)
    await qmrestore(dest, vmid, storage, force, pct =>
        progress.update(template.name, 'install', pct, `VMID ${vmid}`)
    )

    progress.update(template.name, 'done', 100, `VMID ${vmid}`)

    import('node:fs/promises').then(({ unlink }) =>
        unlink(dest).catch(() => {})
    )
}

const program = new Command()

program
    .name('coport')
    .description('Install Cofoundry VM templates into Proxmox')
    .version('0.1.0')
    .argument(
        '[registry]',
        'Registry URL, file path, or omit to use default/config'
    )
    .option('-s, --storage <name>', 'Proxmox storage volume (skips prompt)')
    .option('-g, --group <id>', 'Only show/install templates from this group')
    .option('-f, --filter <tag>', 'Only show/install templates with this tag')
    .option('--vmid-start <n>', 'Auto-VMID range start for conflicts', '9000')
    .option('--dry-run', 'Show what would be installed; skip downloads')
    .option(
        '--overwrite',
        'Overwrite existing VMs when a suggested VMID is already taken'
    )
    .option('--no-verify', 'Skip SHA-256 verification after download')
    .option('--json', 'NDJSON progress output for scripted use')
    .action(async (registryArg: string | undefined, opts) => {
        const { registrySource, defaultStorage } =
            await resolveConfig(registryArg)

        log.info(`Registry: ${registrySource}`)
        const registry = await fetchRegistry(registrySource)
        log.success(
            `Loaded "${registry.name}" (${registry.groups.reduce((n, g) => n + g.templates.length, 0)} templates)`
        )

        const storage =
            (opts.storage ?? defaultStorage) || (await promptStorage())

        const selected = await promptTemplateSelection(
            registry,
            opts.group,
            opts.filter
        )
        if (selected.length === 0) {
            log.warn('No templates selected.')
            process.exit(0)
        }

        const vmidStart = Number(opts.vmidStart)
        const assignments = await resolveVmids(
            selected,
            vmidStart,
            opts.overwrite
        )

        const ok = await confirmVmidConflicts(assignments)
        if (!ok) {
            log.warn('Aborted.')
            process.exit(0)
        }

        if (opts.dryRun) {
            console.log()
            console.log(pc.bold('Dry run — would install:'))
            for (const a of assignments) {
                console.log(
                    `  ${a.template.name}  →  VMID ${a.vmid}  (${storage})`
                )
            }
            process.exit(0)
        }

        await ensureTempDir()

        const progress = new ProgressRenderer(
            assignments.map(a => a.template.name)
        )

        const results = await Promise.allSettled(
            assignments.map(async a =>
                installTemplate(
                    a.template,
                    a.vmid,
                    storage,
                    !opts.noVerify,
                    a.overwrite,
                    progress
                ).catch(err => {
                    progress.update(
                        a.template.name,
                        'failed',
                        100,
                        err instanceof Error ? err.message : String(err)
                    )
                    throw err
                })
            )
        )

        progress.finish()

        console.log()
        let failed = 0
        for (let i = 0; i < results.length; i++) {
            const r = results[i]!
            const name = assignments[i]!.template.name
            if (r.status === 'fulfilled') {
                log.success(
                    `${name} — installed as VMID ${assignments[i]!.vmid}`
                )
            } else {
                log.error(`${name} — FAILED: ${(r.reason as Error).message}`)
                failed++
            }
        }

        if (failed > 0) process.exit(1)
    })

program.parseAsync(process.argv).catch(err => {
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
