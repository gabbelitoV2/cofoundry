import { Command } from 'commander'
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

const createProgressReporter = (
    name: string,
    phase: string
): ((pct: number) => void) => {
    let last = -1

    return pct => {
        if (pct === last) return
        last = pct

        if (process.stdout.isTTY) {
            process.stdout.write(`\r  ${name}: ${phase} ${pct}%  `)
            return
        }

        if (pct === 100 || pct % 10 === 0) {
            log.info(`${name}: ${phase} ${pct}%`)
        }
    }
}

const finishProgressLine = (): void => {
    if (process.stdout.isTTY) process.stdout.write('\n')
}

const installTemplate = async (
    template: Template,
    vmid: number,
    storage: string,
    verify: boolean
): Promise<void> => {
    const dest = tempPath(vmid)

    log.info(`[${template.name}] downloading...`)
    await downloadWithRetry(
        template.url,
        dest,
        createProgressReporter(template.name, 'download')
    )
    finishProgressLine()

    if (verify) {
        log.info(`[${template.name}] verifying SHA-256...`)
        await verifySha256(dest, template.sha256)
    }

    log.info(`[${template.name}] installing as VMID ${vmid}...`)
    await qmrestore(
        dest,
        vmid,
        storage,
        createProgressReporter(template.name, 'install')
    )
    finishProgressLine()

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
        const assignments = await resolveVmids(selected, vmidStart)

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

        const results = await Promise.allSettled(
            assignments.map(a =>
                installTemplate(a.template, a.vmid, storage, !opts.noVerify)
            )
        )

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
