import type { Command } from 'commander'
import { runClean, runPrune, runPruneR2 } from '@/prune.ts'
import { runBootstrap } from '@/bootstrap.ts'
import { runVerify } from '@/verify.ts'
import { loadRecipe } from '@/config.ts'
import { loadEnv, loadEnvPartial } from '@/env.ts'

export const registerMaintenanceCommands = (program: Command): void => {
    program
        .command('clean')
        .description('Remove remote build leftovers and uploaded ISOs')
        .action(async () => runClean(loadEnv()))

    program
        .command('prune')
        .description('Reclaim space on the Proxmox node or in R2')
        .option('--days <n>', 'Treat files older than N days as stale', '30')
        .option('--dry-run', 'Enumerate targets without deleting', false)
        .option('--r2', 'Prune R2 templates/ objects instead of node files')
        .option(
            '--keep <n>',
            'With --r2: keep newest N per template prefix',
            '5'
        )
        .action(
            async (opts: {
                days: string
                dryRun: boolean
                r2?: boolean
                keep: string
            }) => {
                if (opts.r2) {
                    const env = loadEnvPartial()
                    if (!env.R2_ENDPOINT || !env.R2_BUCKET)
                        throw new Error(
                            'R2_ENDPOINT and R2_BUCKET are required for --r2 prune'
                        )
                    await runPruneR2(
                        {
                            endpoint: env.R2_ENDPOINT,
                            bucket: env.R2_BUCKET,
                            prefix: env.R2_PREFIX ?? 'templates/',
                        },
                        {
                            keep: Number.parseInt(opts.keep, 10),
                            dryRun: Boolean(opts.dryRun),
                        }
                    )
                    return
                }
                await runPrune(loadEnv(), {
                    days: Number.parseInt(opts.days, 10),
                    dryRun: Boolean(opts.dryRun),
                })
            }
        )

    program
        .command('bootstrap')
        .description('Interactively provision a fresh Proxmox build node')
        .action(async () => runBootstrap(loadEnvPartial()))

    program
        .command('verify <name>')
        .description('Restore and boot a built artifact as a smoke test')
        .action(async (name: string) => {
            await runVerify(loadEnv(), await loadRecipe(name))
        })
}
