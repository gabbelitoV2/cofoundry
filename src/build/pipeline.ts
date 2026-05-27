import PQueue from 'p-queue'
import { Listr, PRESET_TIMER, type ListrTaskWrapper, type ListrRendererFactory } from 'listr2'
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
    fmtElapsed,
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
    verbose?: boolean
    outputLines?: number
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

// Throttle progress emissions so the verbose renderer doesn't get a new line
// per kilobyte. The final 100% always emits.
const throttle = (intervalMs: number, fn: (s: string) => void): ((s: string, force?: boolean) => void) => {
    let last = 0
    return (s, force = false) => {
        const now = Date.now()
        if (!force && now - last < intervalMs) return
        last = now
        fn(s)
    }
}

const setTaskOutput = (
    task: Task,
    label: string,
    throttleMs: number,
    prefix = ''
): OnProgress => {
    const emit = throttle(throttleMs, s => {
        task.output = s
    })
    return ev => {
        const done = ev.doneFiles === ev.totalFiles && ev.doneBytes === ev.totalBytes
        const s = transferOutput(label, ev)
        emit(prefix ? `${prefix}: ${s}` : s, done)
    }
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

    const renderer = rendererFor({ ci: opts.ci, verbose: opts.verbose })
    // `default` renderer overwrites a single line — fast refresh feels smooth.
    // `simple` / `verbose` append, so frequent updates spam — slow them down.
    const throttleMs = renderer === 'default' ? 100 : 1000
    const outputBar = Math.max(1, opts.outputLines ?? 1)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tasks = new (Listr as any)(
        [
            ...(opts.skipRepoSync
                ? []
                : [
                      {
                          title: 'sync repo to remote',
                          // outputBar=1: only the latest status line under the spinner.
                          // The repo sync is one ephemeral step, not a log stream.
                          rendererOptions: { outputBar: 1, persistentOutput: false },
                          task: async (_ctx: unknown, task: Task) => {
                              const start = Date.now()
                              let phaseText = 'starting…'
                              const writeTitle = (): void => {
                                  const elapsed = fmtElapsed(Date.now() - start)
                                  task.title = `sync repo to remote · ${phaseText} [${elapsed}]`
                              }
                              const setPhase = (s: string): void => {
                                  phaseText = s
                                  writeTitle()
                              }
                              const ticker = setInterval(writeTitle, 1000)
                              const emit = throttle(throttleMs, setPhase)
                              try {
                                  await syncRepoToRemote(env, {
                                      concurrency: opts.uploadConcurrency,
                                      onPhase: phase => setPhase(phase),
                                      onProgress: ev => {
                                          const done = ev.doneFiles === ev.totalFiles && ev.doneBytes === ev.totalBytes
                                          emit(formatTransferStatus(
                                              ev.direction,
                                              ev.doneBytes,
                                              ev.totalBytes,
                                              ev.doneFiles,
                                              ev.totalFiles,
                                              ev.currentFile,
                                              ev.startMs
                                          ), done)
                                      },
                                  })
                              } finally {
                                  clearInterval(ticker)
                                  task.title = 'sync repo to remote'
                              }
                          },
                      },
                  ]),
            {
                title: `build ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`,
                task: (_ctx: unknown, task: Task) =>
                    task.newListr(
                        recipes.map(recipe => ({
                            title: `${recipe.name} · queued`,
                            // outputBar shows the last N `task.output` lines under the spinner.
                            // No sub-Listr — one row per recipe so many concurrent recipes fit.
                            rendererOptions: { outputBar, persistentOutput: false },
                            task: (_c: unknown, recipeTask: Task) =>
                                runRecipe(env, recipe, opts, recipeTask, {
                                    prefetchQ,
                                    buildQ,
                                    syncQ,
                                    passed,
                                    failed,
                                    throttleMs,
                                }),
                        })),
                        { concurrent: true, exitOnError: false }
                    ),
            },
        ],
        {
            renderer,
            fallbackRenderer: 'simple',
            exitOnError: false,
            rendererOptions: { timer: PRESET_TIMER },
            fallbackRendererOptions: { timer: PRESET_TIMER },
        }
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
    throttleMs: number
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

// p-queue positional hint. `pending` is in-flight, `size` is waiting.
const queueAhead = (q: PQueue): number => Math.max(0, q.pending + q.size - q.concurrency)

const runRecipe = async (
    env: Env,
    recipe: RecipeInfo,
    opts: PipelineOptions,
    task: Task,
    ctx: RecipeContext
): Promise<void> => {
    // `task.title` carries phase + transient progress (wget %, sftp %) and a
    // live elapsed timer. `task.output` is the packer log stream so the
    // renderer's `outputBar = N` accumulates packer scrollback, not progress.
    const recipeStart = Date.now()
    let currentPhase = 'queued'
    const writeTitle = (): void => {
        const elapsed = fmtElapsed(Date.now() - recipeStart)
        task.title = `${recipe.name} · ${currentPhase} [${elapsed}]`
    }
    const setTitle = (s: string): void => {
        currentPhase = s
        writeTitle()
    }
    const setOut = (s: string): void => {
        task.output = s
    }
    const phaseTitle = (phase: string, q: PQueue): string => {
        const ahead = queueAhead(q)
        return ahead > 0 ? `${phase} · queued (${ahead} ahead)` : phase
    }
    const titleEmitter = throttle(ctx.throttleMs, setTitle)
    // Tick the title every second so the elapsed timer is live even when the
    // current phase isn't producing progress updates (e.g. packer mid-step).
    const ticker = setInterval(writeTitle, 1000)

    try {
    // ── prefetch ── (progress goes in title, not output)
    setTitle(phaseTitle('prefetch', ctx.prefetchQ))
    await ctx.prefetchQ.add(async () => {
        setTitle('prefetch')
        try {
            await prefetchPhase(env, recipe, (slot, line) => {
                const p = parseWgetLine(line)
                if (!p) return
                titleEmitter(`prefetch · ${formatWgetStatus(slot, p)}`, p.pct >= 100)
            })
        } catch (err) {
            throw recordFailure(ctx, recipe, err)
        }
    })

    // ── build ── (packer lines go in output — this is what outputBar shows)
    setTitle(phaseTitle('build', ctx.buildQ))
    await ctx.buildQ.add(async () => {
        setTitle('build')
        try {
            await buildPhase(env, recipe, { keepVm: opts.keepVm }, line => {
                const trimmed = line.trim()
                if (!trimmed) return
                setOut(opts.verbose ? trimmed : trimmed.slice(0, 200))
            })
        } catch (err) {
            throw recordFailure(ctx, recipe, err)
        }
    })

    if (!opts.syncBack) {
        ctx.passed.push(recipe.name)
        return
    }

    // ── sync ── (progress goes in title, not output)
    setTitle(phaseTitle('sync', ctx.syncQ))
    await ctx.syncQ.add(async () => {
        setTitle('sync')
        try {
            const emit = throttle(ctx.throttleMs, (s: string) => setTitle(s))
            await syncPhase(env, recipe, {
                concurrency: opts.downloadConcurrency,
                onProgress: ev => {
                    const done = ev.doneFiles === ev.totalFiles && ev.doneBytes === ev.totalBytes
                    emit(`sync · ${formatTransferStatus(
                        ev.direction,
                        ev.doneBytes,
                        ev.totalBytes,
                        ev.doneFiles,
                        ev.totalFiles,
                        ev.currentFile,
                        ev.startMs
                    )}`, done)
                },
            })
            ctx.passed.push(recipe.name)
        } catch (err) {
            throw recordFailure(ctx, recipe, err)
        }
    })
    } finally {
        clearInterval(ticker)
        // Drop the live timer suffix on completion so Listr's own
        // PRESET_TIMER ([Xm Ys]) renders cleanly without doubling up.
        task.title = `${recipe.name}`
    }
}

