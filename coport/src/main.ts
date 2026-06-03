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
    cleanupTempDir,
    cleanupTempDirSync,
} from './download.ts'
import { qmrestore } from './install.ts'
import {
    promptStorage,
    promptTemplateSelection,
    confirmVmidConflicts,
    closePrompts,
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
    startedAt: number
    message?: string
    received?: number
    total?: number
}

interface ProgressUpdate {
    message?: string
    received?: number
    total?: number
}

const fmtBytes = (n: number): string => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`
    return `${n}B`
}

const fmtElapsed = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

class ProgressRenderer {
    private rows = new Map<string, ProgressRow>()
    private lastLog = new Map<string, number>()
    private readonly enabled = process.stdout.isTTY

    constructor(names: string[]) {
        for (const name of names) {
            this.rows.set(name, {
                name,
                phase: 'queued',
                pct: 0,
                startedAt: Date.now(),
            })
        }
    }

    update(
        name: string,
        phase: ProgressPhase,
        pct: number,
        update: string | ProgressUpdate = {}
    ): void {
        const row = this.rows.get(name) ?? {
            name,
            phase,
            pct: 0,
            startedAt: Date.now(),
        }
        const clamped = Math.max(0, Math.min(100, pct))
        const details =
            typeof update === 'string' ? { message: update } : update
        if (
            row.phase === phase &&
            row.pct === clamped &&
            row.message === details.message &&
            row.received === details.received &&
            row.total === details.total
        )
            return

        if (row.phase !== phase && phase !== 'done' && phase !== 'failed') {
            row.startedAt = Date.now()
        }
        row.phase = phase
        row.pct = clamped
        row.message = details.message
        row.received = details.received
        row.total = details.total
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
            `${row.name}: ${row.phase} ${row.pct}%${this.formatDetails(row)}`
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
        const details = this.formatDetails(row)

        if (row.phase === 'done') {
            return `  ${pc.green('OK')} ${label} ${phase} [${bar}] ${pct}%${details}${text}`
        }
        if (row.phase === 'failed') {
            return `  ${pc.red('!!')} ${label} ${phase} [${bar}] ${pct}%${details}${text}`
        }
        if (row.phase === 'queued') {
            return `  ${pc.dim('--')} ${label} ${pc.dim(phase)} [${bar}] ${pct}%${details}${text}`
        }
        return `  ${pc.cyan('>>')} ${label} ${phase} [${bar}] ${pct}%${details}${text}`
    }

    private formatDetails(row: ProgressRow): string {
        const elapsedMs = Math.max(0, Date.now() - row.startedAt)
        const parts = [fmtElapsed(elapsedMs)]

        if (row.phase === 'download' && row.received !== undefined) {
            const total = row.total && row.total > 0 ? row.total : undefined
            const speed = elapsedMs > 0 ? row.received / (elapsedMs / 1000) : 0
            parts.push(
                total
                    ? `${fmtBytes(row.received)}/${fmtBytes(total)}`
                    : fmtBytes(row.received)
            )
            parts.push(`${fmtBytes(speed)}/s`)
        }

        return `  ${pc.dim(parts.join('  '))}`
    }
}

const installTemplate = async (
    template: Template,
    vmid: number,
    storage: string,
    verify: boolean,
    force: boolean,
    progress: ProgressRenderer,
    signal: AbortSignal
): Promise<void> => {
    const dest = tempPath(vmid)

    progress.update(template.name, 'download', 0)
    await downloadWithRetry(
        template.url,
        dest,
        p =>
            progress.update(template.name, 'download', p.pct, {
                received: p.received,
                total: p.total,
            }),
        signal
    )

    if (verify) {
        progress.update(template.name, 'verify', 0)
        await verifySha256(dest, template.sha256)
    }

    progress.update(template.name, 'install', 0, `VMID ${vmid}`)
    await qmrestore(
        dest,
        vmid,
        storage,
        force,
        pct => progress.update(template.name, 'install', pct, `VMID ${vmid}`),
        signal
    )

    progress.update(template.name, 'done', 100, `VMID ${vmid}`)
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
        const abort = new AbortController()
        let interrupted = false
        process.once('SIGINT', () => {
            interrupted = true
            abort.abort()
            logUpdate.done()
            log.warn('Interrupted; stopping active downloads/restores...')
            cleanupTempDirSync()
            closePrompts()
            process.exit(130)
        })

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
                    progress,
                    abort.signal
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
        await cleanupTempDir()
        closePrompts()

        console.log()
        if (interrupted) {
            log.warn(
                'Interrupted. Temporary archives were removed; inspect Proxmox for any partial restores before retrying.'
            )
            process.exit(130)
        }

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
    cleanupTempDirSync()
    closePrompts()
    log.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
