import { Command } from 'commander'
import {
    createRenderer,
    log,
    title,
    dim,
    accent,
    fmtBytes,
    fmtRate,
    fmtPercent,
    type Renderer,
    type TaskHandle,
} from '@cofoundry/ui'
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
    removeTempFile,
    sweepStaleTempDirs,
} from './download.ts'
import { qmrestore } from './install.ts'
import {
    promptStorage,
    promptTemplateSelection,
    confirmVmidConflicts,
    closePrompts,
} from './prompt.ts'
import type { Template } from '../../src/registry/schema.ts'

type Phase = 'download' | 'verify' | 'install'

const phaseLabel = (phase: Phase): string => {
    switch (phase) {
        case 'download':
            return 'downloading'
        case 'verify':
            return 'verifying'
        case 'install':
            return 'installing'
    }
}

const formatDownload = (
    received: number,
    total: number,
    startedAt: number
): string => {
    const elapsed = Math.max(1, Date.now() - startedAt)
    const pct = total > 0 ? (received / total) * 100 : 0
    const size = total > 0 ? `${fmtBytes(received)}/${fmtBytes(total)}` : fmtBytes(received)
    return `${fmtPercent(pct)} ${dim('·')} ${size} ${dim('·')} ${fmtRate(received, elapsed)}`
}

const installTemplate = async (
    template: Template,
    vmid: number,
    storage: string,
    verify: boolean,
    force: boolean,
    task: TaskHandle,
    signal: AbortSignal
): Promise<void> => {
    const dest = tempPath(vmid)

    const downloadStartedAt = Date.now()
    task.setPhase(`${phaseLabel('download')} ${dim(`→ VMID ${vmid}`)}`)
    await downloadWithRetry(
        template.url,
        dest,
        p =>
            task.setProgress(
                formatDownload(p.received, p.total, downloadStartedAt)
            ),
        signal
    )

    if (verify) {
        task.setPhase(`${phaseLabel('verify')} ${dim(`→ VMID ${vmid}`)}`)
        task.setProgress('SHA-256')
        await verifySha256(dest, template.sha256)
    }

    task.setPhase(`${phaseLabel('install')} ${dim(`→ VMID ${vmid}`)}`)
    task.setProgress(fmtPercent(0))
    await qmrestore(
        dest,
        vmid,
        storage,
        force,
        pct => task.setProgress(fmtPercent(pct)),
        signal
    )

    await removeTempFile(dest)
    task.succeed(`installed as ${accent(`VMID ${vmid}`)}`)
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
    .option('--verbose', 'Stream per-event logs instead of in-place TUI')
    .action(async (registryArg: string | undefined, opts) => {
        const abort = new AbortController()
        let interrupted = false
        let activeRenderer: Renderer | undefined
        process.once('SIGINT', () => {
            interrupted = true
            abort.abort()
            activeRenderer?.finish()
            log.warn('Interrupted; stopping active downloads/restores...')
            cleanupTempDirSync()
            closePrompts()
            process.exit(130)
        })

        const { registrySource, defaultStorage } =
            await resolveConfig(registryArg)

        log.info(`Registry: ${dim(registrySource)}`)
        const registry = await fetchRegistry(registrySource)
        const count = registry.groups.reduce(
            (n, g) => n + g.templates.length,
            0
        )
        log.ok(`Loaded ${accent(`"${registry.name}"`)} ${dim(`(${count} templates)`)}`)

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
            log.section('Dry run — would install')
            for (const a of assignments) {
                log.raw(
                    `  ${a.template.name.padEnd(28)} ${dim('→')} VMID ${accent(String(a.vmid))} ${dim(`(${storage})`)}`
                )
            }
            log.blank()
            process.exit(0)
        }

        await sweepStaleTempDirs()
        await ensureTempDir()

        const renderer = createRenderer({
            title: title(`Installing ${assignments.length} template${assignments.length === 1 ? '' : 's'} → ${accent(storage)}`),
            verbose: opts.verbose,
            outputLines: 1,
        })
        activeRenderer = renderer

        const results = await Promise.allSettled(
            assignments.map(async a => {
                const task = renderer.task(a.template.name)
                try {
                    await installTemplate(
                        a.template,
                        a.vmid,
                        storage,
                        !opts.noVerify,
                        a.overwrite,
                        task,
                        abort.signal
                    )
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    task.fail(msg)
                    throw err
                }
            })
        )

        renderer.finish()
        await cleanupTempDir()
        closePrompts()

        if (interrupted) {
            log.warn(
                'Interrupted. Temporary archives were removed; inspect Proxmox for any partial restores before retrying.'
            )
            process.exit(130)
        }

        const passed = results.filter(r => r.status === 'fulfilled').length
        const failed = results.length - passed
        log.blank()
        if (failed === 0) {
            log.ok(`Installed ${passed}/${results.length} templates.`)
        } else {
            log.err(`${failed} failed, ${passed} succeeded.`)
            process.exit(1)
        }
    })

program.parseAsync(process.argv).catch(err => {
    cleanupTempDirSync()
    closePrompts()
    log.err(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
