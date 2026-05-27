import PQueue from 'p-queue'
import type { Env } from '../env.ts'
import type { RecipeInfo } from '../config.ts'
import {
    syncRepoToRemote,
    prefetchPhase,
    buildPhase,
    syncPhase,
} from '../build.ts'
import { redactSensitive } from '../util.ts'
import {
    formatTransferStatus,
    parseWgetLine,
    formatWgetStatus,
} from './ui.ts'
import { createRenderer, type Renderer, type TaskHandle } from './render.ts'

export type PipelineOptions = {
    syncBack: boolean
    skipRepoSync?: boolean
    keepVm?: boolean
    uploadConcurrency?: number
    downloadConcurrency?: number
    prefetchConcurrency?: number
    ci?: boolean
    verbose?: boolean
    outputLines?: number
}

export type PipelineResult = {
    passed: string[]
    failed: { name: string; error: string }[]
}

// p-queue positional hint. `pending` is in-flight, `size` is waiting.
const queueAhead = (q: PQueue): number =>
    Math.max(0, q.pending + q.size - q.concurrency)

const phaseTitle = (phase: string, q: PQueue): string => {
    const ahead = queueAhead(q)
    return ahead > 0 ? `${phase} · queued (${ahead} ahead)` : phase
}

export const runPipeline = async (
    env: Env,
    recipes: RecipeInfo[],
    opts: PipelineOptions
): Promise<PipelineResult> => {
    const prefetchQ = new PQueue({ concurrency: opts.prefetchConcurrency ?? 3 })
    const buildQ = new PQueue({ concurrency: 1 })
    const syncQ = new PQueue({ concurrency: 1 })

    const passed: string[] = []
    const failed: { name: string; error: string }[] = []

    const renderer = createRenderer({
        ci: opts.ci,
        verbose: opts.verbose,
        outputLines: opts.outputLines,
    })

    try {
        if (!opts.skipRepoSync) {
            await runRepoSync(env, opts, renderer)
        }

        await Promise.allSettled(
            recipes.map(recipe =>
                runRecipe(env, recipe, opts, renderer, {
                    prefetchQ,
                    buildQ,
                    syncQ,
                    passed,
                    failed,
                })
            )
        )
    } finally {
        renderer.finish()
    }

    return { passed, failed }
}

const runRepoSync = async (
    env: Env,
    opts: PipelineOptions,
    renderer: Renderer
): Promise<void> => {
    const handle = renderer.task('sync repo to remote')
    try {
        await syncRepoToRemote(env, {
            concurrency: opts.uploadConcurrency,
            onPhase: phase => handle.setPhase(phase),
            onProgress: ev => {
                handle.setProgress(
                    formatTransferStatus(
                        ev.direction,
                        ev.doneBytes,
                        ev.totalBytes,
                        ev.doneFiles,
                        ev.totalFiles,
                        ev.currentFile,
                        ev.startMs
                    )
                )
            },
        })
        handle.succeed()
    } catch (err) {
        const msg = redactSensitive(err instanceof Error ? err.message : String(err))
        handle.fail(msg)
        throw err
    }
}

type RecipeContext = {
    prefetchQ: PQueue
    buildQ: PQueue
    syncQ: PQueue
    passed: string[]
    failed: { name: string; error: string }[]
}

const recordFailure = (
    ctx: RecipeContext,
    recipe: RecipeInfo,
    err: unknown,
    handle: TaskHandle
): Error => {
    const msg = redactSensitive(err instanceof Error ? err.message : String(err))
    if (!ctx.failed.some(f => f.name === recipe.name)) {
        ctx.failed.push({ name: recipe.name, error: msg })
    }
    handle.fail(msg)
    return err instanceof Error ? err : new Error(msg)
}

const runRecipe = async (
    env: Env,
    recipe: RecipeInfo,
    opts: PipelineOptions,
    renderer: Renderer,
    ctx: RecipeContext
): Promise<void> => {
    const handle = renderer.task(recipe.name)

    // ── prefetch ──
    handle.setPhase(phaseTitle('prefetch', ctx.prefetchQ))
    try {
        await ctx.prefetchQ.add(async () => {
            handle.setPhase('prefetch')
            await prefetchPhase(env, recipe, (slot, line) => {
                const p = parseWgetLine(line)
                if (p) handle.setProgress(formatWgetStatus(slot, p))
            })
        })
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }

    // ── build ──
    handle.setPhase(phaseTitle('build', ctx.buildQ))
    try {
        await ctx.buildQ.add(async () => {
            handle.setPhase('build')
            await buildPhase(env, recipe, { keepVm: opts.keepVm }, line => {
                const trimmed = line.trim()
                if (!trimmed) return
                handle.log(opts.verbose ? trimmed : trimmed.slice(0, 200))
            })
        })
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }

    if (!opts.syncBack) {
        ctx.passed.push(recipe.name)
        handle.succeed()
        return
    }

    // ── sync ──
    handle.setPhase(phaseTitle('sync', ctx.syncQ))
    try {
        await ctx.syncQ.add(async () => {
            handle.setPhase('sync')
            await syncPhase(env, recipe, {
                concurrency: opts.downloadConcurrency,
                onProgress: ev => {
                    handle.setProgress(
                        formatTransferStatus(
                            ev.direction,
                            ev.doneBytes,
                            ev.totalBytes,
                            ev.doneFiles,
                            ev.totalFiles,
                            ev.currentFile,
                            ev.startMs
                        )
                    )
                },
            })
        })
        ctx.passed.push(recipe.name)
        handle.succeed()
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }
}
