import type { Command } from 'commander'
import { listRecipes, loadRecipe } from '@/config.ts'
import { runPipeline, type PipelineOptions } from '@/build/pipeline.ts'
import { type Env, loadEnv } from '@/env.ts'
import { log } from '@/log.ts'

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

const parseNumber = (value?: string): number | undefined =>
    value === undefined ? undefined : Number.parseInt(value, 10)

const shouldSyncBack = (env: Env, opts: BuildCommandOptions): boolean =>
    !opts.skipArtifactSync && !env.CF_SKIP_ARTIFACT_SYNC

export const runBuildCommand = async (
    names: string[],
    opts: BuildCommandOptions
): Promise<void> => {
    const env = loadEnv()
    const recipes =
        names.length > 0
            ? await Promise.all(names.map(name => loadRecipe(name)))
            : await listRecipes()
    if (recipes.length === 0) {
        log.warn('No recipes found in builds/')
        return
    }

    const pipelineOpts: PipelineOptions = {
        syncBack: shouldSyncBack(env, opts),
        skipRepoSync: opts.skipRepoSync,
        keepVm: opts.keepVm || env.CF_KEEP_VM,
        uploadConcurrency: parseNumber(opts.uploadConcurrency),
        downloadConcurrency: parseNumber(opts.downloadConcurrency),
        prefetchConcurrency: parseNumber(opts.prefetchConcurrency),
        ci: opts.ci,
        verbose: opts.verbose,
        outputLines: parseNumber(opts.outputLines),
    }
    const { passed, failed } = await runPipeline(env, recipes, pipelineOpts)

    log.blank()
    log.ok(
        `${passed.length} succeeded${passed.length > 0 ? `: ${passed.join(', ')}` : ''}`
    )
    if (failed.length === 0) return

    log.err(`${failed.length} failed: ${failed.map(f => f.name).join(', ')}`)
    for (const failure of failed) log.note(`${failure.name}: ${failure.error}`)
    process.exitCode = 1
}

export const registerBuildCommand = (program: Command): void => {
    program
        .command('build [names...]')
        .description(
            'Build one or more template artifacts (no names = all recipes); stage-pipelined'
        )
        .option(
            '--skip-artifact-sync',
            'Do not download built artifacts to CF_OUT_DIR (also: CF_SKIP_ARTIFACT_SYNC=1)'
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
        .option('--ci', 'Force line-oriented output for non-TTY environments')
        .option('-v, --verbose', 'Stream full logs for debugging')
        .option(
            '--output-lines <n>',
            'Number of recent log lines to show under each task (default 1)'
        )
        .action(runBuildCommand)
}
