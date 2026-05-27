#!/usr/bin/env bun
import { Command } from 'commander'
import { listRecipes, loadRecipe } from './config.ts'
import { prefetchRecipeAssets, runBuild, syncArtifactsBack, syncRepoToRemote } from './build.ts'
import { MultiDownloadProgress } from './build/wget-progress.ts'
import { runClean, runPrune } from './prune.ts'
import { checkRecipes, SYNTHETIC_RECIPES, saveChecksums } from './upstream.ts'
import { resolveIsoUpdate, applyIsoUpdate } from './update.ts'
import { buildManifest } from './manifest.ts'
import { type Env, loadEnv } from './env.ts'
import { log } from './log.ts'
import { redactSensitive } from './util.ts'

type BuildCommandOptions = {
    skipArtifactSync?: boolean
    skipRepoSync?: boolean
    keepVm?: boolean
}

const shouldSyncBack = (env: Env, opts: BuildCommandOptions): boolean =>
    !opts.skipArtifactSync && !env.CF_SKIP_SYNC_BACK

const program = new Command()
program.name('cf').description('Proxmox template builder').version('0.0.1')

program
    .command('list')
    .description('List available build recipes')
    .action(async () => {
        const recipes = await listRecipes()
        if (recipes.length === 0) return log.warn('No recipes found in builds/')
        for (const r of recipes)
            console.log(`${r.name.padEnd(20)} ${r.display}`)
    })

program
    .command('build <names...>')
    .description('Build one or more template artifacts sequentially')
    .option('--skip-artifact-sync', 'Do not download built artifacts to CF_OUT_DIR')
    .option('--skip-repo-sync', 'Do not sync the repo to the remote node before building')
    .option('--keep-vm', 'Do not destroy the build VM if the build is cancelled (also: CF_KEEP_VM=1)')
    .action(async (names: string[], opts: BuildCommandOptions) => {
        const env = loadEnv()
        if (names.length === 1) {
            const recipe = await loadRecipe(names[0]!)
            await runBuild(env, recipe, {
                syncBack: shouldSyncBack(env, opts),
                skipRepoSync: opts.skipRepoSync,
                keepVm: opts.keepVm || env.CF_KEEP_VM,
            })
            return
        }
        const recipes = await Promise.all(names.map(n => loadRecipe(n)))
        const passed: string[] = []
        const failed: { name: string; error: string }[] = []
        for (const recipe of recipes) {
            try {
                await runBuild(env, recipe, { syncBack: false, skipRepoSync: opts.skipRepoSync, keepVm: opts.keepVm || env.CF_KEEP_VM })
                passed.push(recipe.name)
            } catch (err) {
                const msg = redactSensitive(err instanceof Error ? err.message : String(err))
                log.err(`${recipe.name}: ${msg}`)
                failed.push({ name: recipe.name, error: msg })
            }
        }
        if (passed.length > 0 && shouldSyncBack(env, opts)) await syncArtifactsBack(env)
        console.log('')
        log.ok(`${passed.length} succeeded: ${passed.join(', ') || 'none'}`)
        if (failed.length > 0) {
            log.err(`${failed.length} failed: ${failed.map(f => f.name).join(', ')}`)
            process.exit(1)
        }
    })

program
    .command('build-all')
    .description(
        'Build all recipes sequentially; continues on failure and prints a summary'
    )
    .option('--skip-artifact-sync', 'Do not download built artifacts to CF_OUT_DIR')
    .action(async (opts: BuildCommandOptions) => {
        const env = loadEnv()
        const recipes = await listRecipes()
        if (recipes.length === 0) return log.warn('No recipes found in builds/')

        const syncBack = shouldSyncBack(env, opts)

        await syncRepoToRemote(env)

        log.step(`prefetching ISOs and assets in parallel (${recipes.length} recipes)`)
        const prefetchTracker = new MultiDownloadProgress()
        const prefetchResults = await Promise.allSettled(
            recipes.map(r => prefetchRecipeAssets(env, r, prefetchTracker))
        )

        const passed: string[] = []
        const failed: { name: string; error: string }[] = []

        for (let i = 0; i < recipes.length; i++) {
            const recipe = recipes[i]!
            const prefetch = prefetchResults[i]!
            if (prefetch.status === 'rejected') {
                const msg = redactSensitive(
                    prefetch.reason instanceof Error
                        ? prefetch.reason.message
                        : String(prefetch.reason)
                )
                log.err(`${recipe.name}: prefetch failed — ${msg}`)
                failed.push({ name: recipe.name, error: `prefetch: ${msg}` })
                continue
            }
            try {
                await runBuild(env, recipe, { syncBack: false, skipRepoSync: true, skipPrefetch: true })
                passed.push(recipe.name)
            } catch (err) {
                const msg = redactSensitive(
                    err instanceof Error ? err.message : String(err)
                )
                log.err(`${recipe.name}: ${msg}`)
                failed.push({ name: recipe.name, error: msg })
            }
        }

        if (passed.length > 0) {
            if (!syncBack) {
                log.step(`skip syncing artifacts back`)
            } else {
                await syncArtifactsBack(env)
            }
        }

        console.log('')
        log.ok(`${passed.length} succeeded: ${passed.join(', ') || 'none'}`)
        if (failed.length > 0) {
            log.err(
                `${failed.length} failed: ${failed.map(f => f.name).join(', ')}`
            )
            process.exit(1)
        }
    })

program
    .command('update [names...]')
    .description(
        'Fetch upstream checksum files and update iso_url, iso_checksum, and iso_file in HCL recipes'
    )
    .action(async (names: string[]) => {
        const recipes = names.length > 0
            ? await Promise.all(names.map(n => loadRecipe(n)))
            : await listRecipes()
        const updatable = recipes.filter(r => r.isoChecksumUrl && r.isoFilenameRe)
        if (updatable.length === 0) return log.warn('No recipes with iso_checksum_url found')

        const updated: string[] = []
        const failed: { name: string; error: string }[] = []

        for (const recipe of updatable) {
            try {
                const iso = await resolveIsoUpdate(recipe)
                if (!iso) continue
                const changed = await applyIsoUpdate(recipe, iso)
                if (changed) {
                    log.ok(`${recipe.name}: updated → ${iso.filename}`)
                    updated.push(recipe.name)
                } else {
                    log.info(`${recipe.name}: already up to date`)
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                log.err(`${recipe.name}: ${msg}`)
                failed.push({ name: recipe.name, error: msg })
            }
        }

        console.log('')
        if (updated.length > 0) log.ok(`updated: ${updated.join(', ')}`)
        else log.info('nothing changed')
        if (failed.length > 0) {
            log.err(`failed: ${failed.map(f => f.name).join(', ')}`)
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

        for (const r of results) {
            if (r.error) {
                log.warn(`${r.name}: error — ${r.error}`)
            } else if (r.changed) {
                log.info(`${r.name}: upstream changed`)
            } else {
                log.info(`${r.name}: up to date`)
            }
        }

        await saveChecksums(store)

        const changed = results
            .filter(r => r.changed && !r.error)
            .map(r => r.name)
        if (opts.json) {
            console.log(JSON.stringify(changed))
        } else if (changed.length > 0) {
            log.ok(
                `${changed.length} recipe(s) have a new upstream ISO: ${changed.join(', ')}`
            )
        } else {
            log.ok('All recipes are up to date')
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
    .action(async (opts: { days: string; dryRun: boolean }) => {
        const env = loadEnv()
        await runPrune(env, {
            days: parseInt(opts.days, 10),
            dryRun: Boolean(opts.dryRun),
        })
    })

program
    .command('publish')
    .description('Aggregate sidecar JSONs in CF_OUT_DIR into registry.json')
    .action(async () => {
        const env = loadEnv()
        await buildManifest(env.CF_OUT_DIR)
    })

program.parseAsync(process.argv).catch(err => {
    log.err(redactSensitive(err instanceof Error ? err.message : String(err)))
    process.exit(1)
})
