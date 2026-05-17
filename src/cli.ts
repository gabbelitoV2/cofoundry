#!/usr/bin/env bun
import { Command } from 'commander'
import { listRecipes, loadRecipe } from './config.ts'
import { runBuild } from './build.ts'
import { runClean, runPrune } from './prune.ts'
import { checkRecipes, saveChecksums } from './upstream.ts'
import { buildManifest } from './manifest.ts'
import { loadEnv } from './env.ts'
import { log } from './log.ts'

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
    .command('build <name>')
    .description('Build a template artifact using Packer')
    .action(async (name: string) => {
        const env = loadEnv()
        const recipe = await loadRecipe(name)
        await runBuild(env, recipe)
    })

program
    .command('build-all')
    .description(
        'Build all recipes sequentially; continues on failure and prints a summary'
    )
    .action(async () => {
        const env = loadEnv()
        const recipes = await listRecipes()
        if (recipes.length === 0) return log.warn('No recipes found in builds/')

        const passed: string[] = []
        const failed: { name: string; error: string }[] = []

        for (const recipe of recipes) {
            try {
                await runBuild(env, recipe)
                passed.push(recipe.name)
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                log.err(`${recipe.name}: ${msg}`)
                failed.push({ name: recipe.name, error: msg })
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
    .command('check [name]')
    .description(
        'Check upstream ISO URLs for changes; updates upstream-checksums.json'
    )
    .option('--json', 'Output changed recipe names as a JSON array (for CI)')
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
        const recipes = name ? [await loadRecipe(name)] : await listRecipes()
        const withUrl = recipes.filter(r => r.isoUrl)
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
        'Remove the remote working directory (/tmp/cofoundry) to free tmpfs space'
    )
    .action(async () => {
        const env = loadEnv()
        await runClean(env)
    })

program
    .command('prune')
    .description(
        'Remove ephemeral Packer ISOs and stale iso-cache files from the Proxmox node'
    )
    .option('--days <n>', 'Remove iso-cache files older than N days', '30')
    .action(async (opts: { days: string }) => {
        const env = loadEnv()
        await runPrune(env, parseInt(opts.days, 10))
    })

program
    .command('publish')
    .description('Aggregate sidecar JSONs in CF_OUT_DIR into images.json')
    .action(async () => {
        const env = loadEnv()
        await buildManifest(env.CF_OUT_DIR)
    })

program.parseAsync(process.argv).catch(err => {
    log.err(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
