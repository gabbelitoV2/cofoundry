import type { Command } from 'commander'
import pc from 'picocolors'
import { listRecipes, loadRecipe } from '@/config.ts'
import { resolveIsoUpdate, applyIsoUpdate } from '@/update.ts'
import { checkRecipes, SYNTHETIC_RECIPES, saveChecksums } from '@/upstream.ts'
import { log } from '@/log.ts'

const listCommand = async (): Promise<void> => {
    const recipes = await listRecipes()
    if (recipes.length === 0) {
        log.warn('No recipes found in builds/')
        return
    }
    log.section(`Recipes ${pc.dim(`(${recipes.length})`)}`)
    const width = Math.max(...recipes.map(recipe => recipe.name.length))
    for (const recipe of recipes) {
        log.raw(
            `  ${pc.cyan(recipe.name.padEnd(width))}  ${pc.dim('·')}  ${recipe.display}`
        )
    }
    log.blank()
}

const updateCommand = async (names: string[]): Promise<void> => {
    const recipes =
        names.length > 0
            ? await Promise.all(names.map(name => loadRecipe(name)))
            : await listRecipes()
    const updatable = recipes.filter(
        recipe => recipe.isoChecksumUrl && recipe.isoFilenameRe
    )
    if (updatable.length === 0) {
        log.warn('No recipes with iso_checksum_url found')
        return
    }

    log.section(
        `Update ISOs ${pc.dim(`(${updatable.length} recipe${updatable.length === 1 ? '' : 's'})`)}`
    )
    const updated: string[] = []
    const failed: string[] = []
    const width = Math.max(...updatable.map(recipe => recipe.name.length))

    for (const recipe of updatable) {
        const label = pc.cyan(recipe.name.padEnd(width))
        try {
            const iso = await resolveIsoUpdate(recipe)
            if (!iso) continue
            if (await applyIsoUpdate(recipe, iso)) {
                log.ok(`${label} ${pc.dim('→')} ${iso.filename}`)
                updated.push(recipe.name)
            } else {
                log.info(`${label} ${pc.dim('·')} already up to date`)
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            log.err(`${label} ${pc.dim('·')} ${message}`)
            failed.push(recipe.name)
        }
    }

    log.blank()
    if (updated.length > 0)
        log.ok(`Updated ${updated.length}/${updatable.length}.`)
    else log.info('No changes.')
    if (failed.length > 0) {
        log.err(`${failed.length} failed: ${failed.join(', ')}`)
        process.exitCode = 1
    }
}

const checkCommand = async (
    name: string | undefined,
    opts: { json?: boolean }
): Promise<void> => {
    const recipes = name ? [await loadRecipe(name)] : await listRecipes()
    const synthetic = SYNTHETIC_RECIPES.map(recipe => ({
        name: recipe.name,
        path: '<synthetic>',
        display: recipe.name,
        isoUrl: recipe.isoUrl,
        arch: 'amd64',
    }))
    const candidates = [...recipes, ...(name ? [] : synthetic)].filter(
        recipe => recipe.isoUrl
    )
    if (candidates.length === 0) {
        log.warn('No recipes with an iso_url found in boot_iso block')
        if (opts.json) console.log('[]')
        return
    }

    const { results, store } = await checkRecipes(candidates)
    if (!opts.json) {
        log.section(
            `Upstream check ${pc.dim(`(${results.length} recipe${results.length === 1 ? '' : 's'})`)}`
        )
        const width = Math.max(...results.map(result => result.name.length))
        for (const result of results) {
            const label = pc.cyan(result.name.padEnd(width))
            if (result.error)
                log.warn(`${label} ${pc.dim('·')} ${result.error}`)
            else if (result.changed)
                log.ok(`${label} ${pc.dim('·')} upstream changed`)
            else log.info(`${label} ${pc.dim('·')} up to date`)
        }
    }

    await saveChecksums(store)
    const changed = results
        .filter(result => result.changed && !result.error)
        .map(result => result.name)
    if (opts.json) console.log(JSON.stringify(changed))
    else {
        log.blank()
        if (changed.length > 0)
            log.ok(
                `${changed.length} recipe(s) have a new upstream ISO: ${changed.join(', ')}`
            )
        else log.ok('All recipes are up to date.')
    }
}

export const registerRecipeCommands = (program: Command): void => {
    program
        .command('list')
        .description('List available build recipes')
        .action(listCommand)

    program
        .command('update [names...]')
        .description(
            'Fetch upstream checksum files and update ISO metadata in HCL recipes'
        )
        .action(updateCommand)

    program
        .command('check [name]')
        .description('Check upstream ISO URLs for changes')
        .option('--json', 'Output changed recipe names as a JSON array')
        .action(checkCommand)
}
