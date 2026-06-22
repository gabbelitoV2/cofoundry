#!/usr/bin/env bun
import { Command } from 'commander'
import { listRecipes, loadRecipe } from './config.ts'
import { runPipeline, type PipelineOptions } from './build/pipeline.ts'
import { runClean, runPrune, runPruneR2 } from './prune.ts'
import { runVerify } from './verify.ts'
import { runBootstrap } from './bootstrap.ts'
import { checkRecipes, SYNTHETIC_RECIPES, saveChecksums } from './upstream.ts'
import { resolveIsoUpdate, applyIsoUpdate } from './update.ts'
import { buildManifest, buildManifestFromR2 } from './manifest.ts'
import { runUpload } from './upload.ts'
import { type Env, loadEnv } from './env.ts'
import { log } from './log.ts'
import { redactSensitive } from './util.ts'
import pc from 'picocolors'
import pkg from '../package.json' with { type: 'json' }

type BuildCommandOptions = {
    skipArtifactSync?: boolean
    skipRepoSync?: boolean
    keepVm?: boolean
    uploadConcurrency?: string
    downloadConcurrency?: string
    prefetchConcurrency?: string
    ci?: boolean
    verbose?: boolean
    outputLines?: string
}

const shouldSyncBack = (env: Env, opts: BuildCommandOptions): boolean =>
    !opts.skipArtifactSync && !env.CF_SKIP_SYNC_BACK

const parseNum = (s?: string): number | undefined =>
    s !== undefined ? parseInt(s, 10) : undefined

const buildAction = async (
    names: string[],
    opts: BuildCommandOptions
): Promise<void> => {
    const env = loadEnv()
    const recipes =
        names.length > 0
            ? await Promise.all(names.map(n => loadRecipe(n)))
            : await listRecipes()
    if (recipes.length === 0) return log.warn('No recipes found in builds/')

    const pipelineOpts: PipelineOptions = {
        syncBack: shouldSyncBack(env, opts),
        skipRepoSync: opts.skipRepoSync,
        keepVm: opts.keepVm || env.CF_KEEP_VM,
        uploadConcurrency: parseNum(opts.uploadConcurrency),
        downloadConcurrency: parseNum(opts.downloadConcurrency),
        prefetchConcurrency: parseNum(opts.prefetchConcurrency),
        ci: opts.ci,
        verbose: opts.verbose,
        outputLines: parseNum(opts.outputLines),
    }

    const { passed, failed } = await runPipeline(env, recipes, pipelineOpts)

    log.blank()
    log.ok(
        `${passed.length} succeeded${passed.length > 0 ? `: ${passed.join(', ')}` : ''}`
    )
    if (failed.length > 0) {
        log.err(
            `${failed.length} failed: ${failed.map(f => f.name).join(', ')}`
        )
        for (const f of failed) log.note(`${f.name}: ${f.error}`)
        process.exit(1)
    }
}

const program = new Command()
program.name('cf').description('Proxmox template builder').version(pkg.version)

program
    .command('list')
    .description('List available build recipes')
    .action(async () => {
        const recipes = await listRecipes()
        if (recipes.length === 0) return log.warn('No recipes found in builds/')
        log.section(`Recipes ${pc.dim(`(${recipes.length})`)}`)
        const w = Math.max(...recipes.map(r => r.name.length))
        for (const r of recipes) {
            log.raw(
                `  ${pc.cyan(r.name.padEnd(w))}  ${pc.dim('·')}  ${r.display}`
            )
        }
        log.blank()
    })

program
    .command('build [names...]')
    .description(
        'Build one or more template artifacts (no names = all recipes); stage-pipelined'
    )
    .option(
        '--skip-artifact-sync',
        'Do not download built artifacts to CF_OUT_DIR'
    )
    .option(
        '--skip-repo-sync',
        'Do not sync the repo to the remote node before building'
    )
    .option(
        '--keep-vm',
        'Do not destroy the build VM if the build is cancelled (also: CF_KEEP_VM=1)'
    )
    .option(
        '--upload-concurrency <n>',
        'Parallel SFTP connections for repo upload (overrides CF_UPLOAD_CONCURRENCY)'
    )
    .option(
        '--download-concurrency <n>',
        'Parallel SFTP connections for artifact download (overrides CF_DOWNLOAD_CONCURRENCY)'
    )
    .option(
        '--prefetch-concurrency <n>',
        'Parallel ISO/asset prefetches on the remote node (default 3)'
    )
    .option(
        '--ci',
        'Force line-oriented output for non-TTY environments (auto-detected from CI env or non-TTY stderr)'
    )
    .option(
        '-v, --verbose',
        'Stream full logs (no truncation, no overwriting) for debugging or copy-paste'
    )
    .option(
        '--output-lines <n>',
        'Number of recent log lines to show under each task (default 1)'
    )
    .action((names: string[], opts: BuildCommandOptions) =>
        buildAction(names, opts)
    )

program
    .command('build-all')
    .description(
        'Alias for `cf build` with no names — build every recipe in the repo'
    )
    .option(
        '--skip-artifact-sync',
        'Do not download built artifacts to CF_OUT_DIR'
    )
    .option(
        '--upload-concurrency <n>',
        'Parallel SFTP connections for repo upload (overrides CF_UPLOAD_CONCURRENCY)'
    )
    .option(
        '--download-concurrency <n>',
        'Parallel SFTP connections for artifact download (overrides CF_DOWNLOAD_CONCURRENCY)'
    )
    .option(
        '--prefetch-concurrency <n>',
        'Parallel ISO/asset prefetches on the remote node (default 3)'
    )
    .option('--ci', 'Force line-oriented output for non-TTY environments')
    .option(
        '-v, --verbose',
        'Stream full logs (no truncation, no overwriting) for debugging'
    )
    .option(
        '--output-lines <n>',
        'Number of recent log lines to show under each task (default 1)'
    )
    .action((opts: BuildCommandOptions) => buildAction([], opts))

program
    .command('update [names...]')
    .description(
        'Fetch upstream checksum files and update iso_url, iso_checksum, and iso_file in HCL recipes'
    )
    .action(async (names: string[]) => {
        const recipes =
            names.length > 0
                ? await Promise.all(names.map(n => loadRecipe(n)))
                : await listRecipes()
        const updatable = recipes.filter(
            r => r.isoChecksumUrl && r.isoFilenameRe
        )
        if (updatable.length === 0)
            return log.warn('No recipes with iso_checksum_url found')

        log.section(
            `Update ISOs ${pc.dim(`(${updatable.length} recipe${updatable.length === 1 ? '' : 's'})`)}`
        )

        const updated: string[] = []
        const failed: { name: string; error: string }[] = []
        const w = Math.max(...updatable.map(r => r.name.length))

        for (const recipe of updatable) {
            const label = pc.cyan(recipe.name.padEnd(w))
            try {
                const iso = await resolveIsoUpdate(recipe)
                if (!iso) continue
                const changed = await applyIsoUpdate(recipe, iso)
                if (changed) {
                    log.ok(`${label} ${pc.dim('→')} ${iso.filename}`)
                    updated.push(recipe.name)
                } else {
                    log.info(`${label} ${pc.dim('·')} already up to date`)
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                log.err(`${label} ${pc.dim('·')} ${msg}`)
                failed.push({ name: recipe.name, error: msg })
            }
        }

        log.blank()
        if (updated.length > 0)
            log.ok(`Updated ${updated.length}/${updatable.length}.`)
        else log.info('No changes.')
        if (failed.length > 0) {
            log.err(
                `${failed.length} failed: ${failed.map(f => f.name).join(', ')}`
            )
            process.exit(1)
        }
    })

program
    .command('check [name]')
    .description(
        'Check upstream ISO URLs for changes; updates upstream-checksums.json'
    )
    .option('--json', 'Output changed recipe names as a JSON array (for CI)')
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
        const recipes = name ? [await loadRecipe(name)] : await listRecipes()
        const synthetic = SYNTHETIC_RECIPES.map(s => ({
            name: s.name,
            path: '<synthetic>',
            display: s.name,
            isoUrl: s.isoUrl,
            arch: 'amd64',
        }))
        const withUrl = [...recipes, ...(name ? [] : synthetic)].filter(
            r => r.isoUrl
        )
        if (withUrl.length === 0) {
            log.warn('No recipes with an iso_url found in boot_iso block')
            if (opts.json) console.log('[]')
            return
        }

        const { results, store } = await checkRecipes(withUrl)

        if (!opts.json) {
            log.section(
                `Upstream check ${pc.dim(`(${results.length} recipe${results.length === 1 ? '' : 's'})`)}`
            )
            const w = Math.max(...results.map(r => r.name.length))
            for (const r of results) {
                const label = pc.cyan(r.name.padEnd(w))
                if (r.error) {
                    log.warn(`${label} ${pc.dim('·')} ${r.error}`)
                } else if (r.changed) {
                    log.ok(`${label} ${pc.dim('·')} upstream changed`)
                } else {
                    log.info(`${label} ${pc.dim('·')} up to date`)
                }
            }
        }

        await saveChecksums(store)

        const changed = results
            .filter(r => r.changed && !r.error)
            .map(r => r.name)
        if (opts.json) {
            console.log(JSON.stringify(changed))
        } else {
            log.blank()
            if (changed.length > 0) {
                log.ok(
                    `${changed.length} recipe(s) have a new upstream ISO: ${changed.join(', ')}`
                )
            } else {
                log.ok('All recipes are up to date.')
            }
        }
    })

program
    .command('clean')
    .description(
        'Remove remote build leftovers: working dir, ISO cache, dump artifacts, and uploaded ISOs'
    )
    .action(async () => {
        const env = loadEnv()
        await runClean(env)
    })

program
    .command('prune')
    .description(
        'Reclaim space on the Proxmox node: ephemeral Packer ISOs, stale iso-cache and vzdump files, orphaned build VMs, and the working dir.'
    )
    .option('--days <n>', 'Treat files older than N days as stale', '30')
    .option('--dry-run', 'Enumerate targets without deleting', false)
    .option('--r2', 'Prune R2 templates/ objects instead of node files')
    .option('--keep <n>', 'With --r2: keep newest N per template prefix', '5')
    .action(
        async (opts: {
            days: string
            dryRun: boolean
            r2?: boolean
            keep: string
        }) => {
            const env = loadEnv()
            if (opts.r2) {
                await runPruneR2({
                    keep: parseInt(opts.keep, 10),
                    dryRun: Boolean(opts.dryRun),
                })
                return
            }
            await runPrune(env, {
                days: parseInt(opts.days, 10),
                dryRun: Boolean(opts.dryRun),
            })
        }
    )

program
    .command('bootstrap')
    .description(
        'Interactively provision a fresh Proxmox node: API token, packer, awscli, iso-cache, vmbr1/dnsmasq, MASQUERADE, tmpfs. Idempotent — safe to re-run.'
    )
    .action(async () => {
        await runBootstrap()
    })

program
    .command('verify <name>')
    .description(
        'Smoke-test a built artifact: qmrestore it on the PVE node, boot, wait for guest agent, then destroy.'
    )
    .action(async (name: string) => {
        const env = loadEnv()
        const recipe = await loadRecipe(name)
        await runVerify(env, recipe)
    })

program
    .command('upload [names...]')
    .description(
        'Upload already-built artifacts to R2 using CF_UPLOAD_CMD (and CF_SIDECAR_UPLOAD_CMD). Reads sidecar JSONs from CF_OUT_DIR and uploads the matching .vma.zst + sidecar.'
    )
    .option(
        '--remote',
        'Upload directly from the PVE node (SSH_TARGET) instead of locally; defaults source-dir to $PVE_DUMP_DIR/cofoundry-out'
    )
    .option(
        '--source-dir <dir>',
        'Directory containing .vma.zst + .json sidecars (default: CF_OUT_DIR, or remote out-dir with --remote)'
    )
    .option('--skip-sidecar', 'Skip sidecar JSON upload')
    .option('--dry-run', 'Print the rendered upload commands without running')
    .action(
        async (
            names: string[],
            opts: {
                remote?: boolean
                sourceDir?: string
                skipSidecar?: boolean
                dryRun?: boolean
            }
        ) => {
            const env = loadEnv()
            await runUpload(env, {
                sourceDir: opts.sourceDir,
                names,
                skipSidecar: opts.skipSidecar,
                dryRun: opts.dryRun,
                remote: opts.remote,
            })
        }
    )

program
    .command('publish')
    .description(
        'Aggregate sidecar JSONs into registry.json at the repo root. By default reads sidecars from CF_OUT_DIR; with --r2, lists them in R2 (newest per template) — required in CI where artifacts are not synced back.'
    )
    .option('--r2', 'Source sidecars from R2 instead of CF_OUT_DIR')
    .option(
        '--prefix <prefix>',
        'R2 key prefix to scan for template sidecars (default: R2_PREFIX or templates/)'
    )
    .option(
        '--source-dir <dir>',
        'Sidecar source dir for local mode (default: CF_OUT_DIR)'
    )
    .option('--out <path>', 'Where to write registry.json', 'registry.json')
    .action(
        async (opts: {
            r2?: boolean
            prefix?: string
            sourceDir?: string
            out: string
        }) => {
            if (opts.r2) {
                await buildManifestFromR2(opts.out, opts.prefix)
                return
            }
            const sourceDir =
                opts.sourceDir || process.env.CF_OUT_DIR || './dist'
            await buildManifest(sourceDir, opts.out)
        }
    )

program.parseAsync(process.argv).catch(err => {
    log.err(redactSensitive(err instanceof Error ? err.message : String(err)))
    process.exit(1)
})
