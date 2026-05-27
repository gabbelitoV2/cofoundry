import PQueue from 'p-queue'
import { Listr, type ListrTaskWrapper, type ListrRendererFactory } from 'listr2'
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
    rendererFor,
    formatTransferStatus,
    parseWgetLine,
    formatWgetStatus,
} from './ui.ts'
import type { OnProgress, TransferEvent } from './sftp.ts'

export type PipelineOptions = {
    syncBack: boolean
    skipRepoSync?: boolean
    keepVm?: boolean
    uploadConcurrency?: number
    downloadConcurrency?: number
    prefetchConcurrency?: number
    ci?: boolean
}

export type PipelineResult = {
    passed: string[]
    failed: { name: string; error: string }[]
}

type Task = ListrTaskWrapper<unknown, ListrRendererFactory, ListrRendererFactory>

const transferOutput = (label: string, ev: TransferEvent): string =>
    `${label}: ${formatTransferStatus(
        ev.direction,
        ev.doneBytes,
        ev.totalBytes,
        ev.doneFiles,
        ev.totalFiles,
        ev.currentFile,
        ev.startMs
    )}`

const setTaskOutput = (task: Task, label: string): OnProgress => ev => {
    task.output = transferOutput(label, ev)
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

    const renderer = rendererFor(opts.ci)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tasks = new (Listr as any)(
        [
            ...(opts.skipRepoSync
                ? []
                : [
                      {
                          title: 'sync repo to remote',
                          task: async (_ctx: unknown, task: Task) => {
                              await syncRepoToRemote(env, {
                                  concurrency: opts.uploadConcurrency,
                                  onPhase: phase => {
                                      task.output = `repo: ${phase}`
                                  },
                                  onProgress: ev => {
                                      task.output = transferOutput('repo', ev)
                                  },
                              })
                          },
                      },
                  ]),
            {
                title: `build ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`,
                task: (_ctx: unknown, task: Task) =>
                    task.newListr(
                        recipes.map(recipe => ({
                            title: recipe.name,
                            task: (_c: unknown, recipeTask: Task) =>
                                recipeTask.newListr(
                                    buildRecipeSubtasks(env, recipe, opts, {
                                        prefetchQ,
                                        buildQ,
                                        syncQ,
                                        passed,
                                        failed,
                                    }),
                                    // Per-recipe phases are SEQUENTIAL: prefetch → build → sync.
                                    // The pipeline parallelism comes from the OUTER list being
                                    // concurrent, plus the p-queues gating stage concurrency.
                                    { concurrent: false, exitOnError: true }
                                ),
                        })),
                        { concurrent: true, exitOnError: false }
                    ),
            },
        ],
        { renderer, fallbackRenderer: 'simple', exitOnError: false }
    )

    await tasks.run()

    return { passed, failed }
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
    err: unknown
): Error => {
    const msg = redactSensitive(err instanceof Error ? err.message : String(err))
    if (!ctx.failed.some(f => f.name === recipe.name)) {
        ctx.failed.push({ name: recipe.name, error: msg })
    }
    return err instanceof Error ? err : new Error(msg)
}

const buildRecipeSubtasks = (
    env: Env,
    recipe: RecipeInfo,
    opts: PipelineOptions,
    ctx: RecipeContext
) => {
    const subtasks = [
        {
            title: 'prefetch',
            task: async (_c: unknown, task: Task) => {
                task.output = 'queued'
                await ctx.prefetchQ.add(async () => {
                    task.output = 'running'
                    try {
                        await prefetchPhase(env, recipe, (slot, line) => {
                            const p = parseWgetLine(line)
                            if (p) task.output = formatWgetStatus(slot, p)
                        })
                    } catch (err) {
                        throw recordFailure(ctx, recipe, err)
                    }
                })
            },
        },
        {
            title: 'build',
            task: async (_c: unknown, task: Task) => {
                task.output = 'queued (build queue serialised to 1)'
                await ctx.buildQ.add(async () => {
                    try {
                        await buildPhase(env, recipe, { keepVm: opts.keepVm }, line => {
                            const trimmed = line.trim()
                            if (trimmed) task.output = trimmed.slice(0, 200)
                        })
                    } catch (err) {
                        throw recordFailure(ctx, recipe, err)
                    }
                })
            },
        },
    ]

    if (opts.syncBack) {
        subtasks.push({
            title: 'sync artifacts',
            task: async (_c: unknown, task: Task) => {
                task.output = 'queued'
                await ctx.syncQ.add(async () => {
                    try {
                        await syncPhase(env, recipe, {
                            concurrency: opts.downloadConcurrency,
                            onProgress: setTaskOutput(task, 'artifacts'),
                        })
                        ctx.passed.push(recipe.name)
                    } catch (err) {
                        throw recordFailure(ctx, recipe, err)
                    }
                })
            },
        })
    } else {
        subtasks.push({
            title: 'register success',
            task: async () => {
                ctx.passed.push(recipe.name)
            },
        })
    }

    return subtasks
}
