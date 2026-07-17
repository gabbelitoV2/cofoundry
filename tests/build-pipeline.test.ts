import { describe, expect, test } from 'bun:test'
import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import { runPipeline, type PipelineDependencies } from '@/build/pipeline.ts'

const env = {} as Env
const recipe = {
    name: 'debian-12',
    display: 'Debian 12',
    path: 'recipes/debian-12.pkr.hcl',
    arch: 'amd64',
    buildMemoryMb: 4096,
    buildCores: 2,
} as RecipeInfo

const dependencies = (
    events: string[],
    failure?: keyof PipelineDependencies
): PipelineDependencies => {
    const run = async (name: keyof PipelineDependencies): Promise<void> => {
        events.push(name)
        if (failure === name) throw new Error(`${name} failed`)
    }
    return {
        syncRepo: async () => run('syncRepo'),
        prefetch: async () => run('prefetch'),
        build: async () => {
            await run('build')
            return { startedAt: 123 }
        },
        sync: async () => run('sync'),
    }
}

describe('runPipeline', () => {
    test('runs repository, prefetch, build, and artifact phases', async () => {
        const events: string[] = []
        const result = await runPipeline(
            env,
            [recipe],
            { syncBack: true, ci: true },
            dependencies(events)
        )
        expect(events).toEqual(['syncRepo', 'prefetch', 'build', 'sync'])
        expect(result).toEqual({ passed: ['debian-12'], failed: [] })
    })

    test('records a phase failure and does not run later phases', async () => {
        const events: string[] = []
        const result = await runPipeline(
            env,
            [recipe],
            { syncBack: true, ci: true, skipRepoSync: true },
            dependencies(events, 'build')
        )
        expect(events).toEqual(['prefetch', 'build'])
        expect(result.passed).toEqual([])
        expect(result.failed).toEqual([
            { name: 'debian-12', error: 'build failed' },
        ])
    })

    test('passes the upload override to the build phase', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.build = async (_env, _recipe, options) => {
            events.push('build')
            expect(options.skipUpload).toBeTrue()
            return { startedAt: 123 }
        }

        await runPipeline(
            env,
            [recipe],
            {
                syncBack: false,
                skipUpload: true,
                skipRepoSync: true,
                ci: true,
            },
            deps
        )

        expect(events).toEqual(['prefetch', 'build'])
    })

    test('requires resource budgets when parallel builds are enabled', async () => {
        expect(
            runPipeline(
                env,
                [recipe],
                {
                    syncBack: false,
                    ci: true,
                    skipRepoSync: true,
                    buildConcurrency: 2,
                },
                dependencies([])
            )
        ).rejects.toThrow('require both a memory budget and a CPU budget')
    })

    test('rejects invalid CLI resource budgets', async () => {
        expect(
            runPipeline(
                env,
                [recipe],
                {
                    syncBack: false,
                    ci: true,
                    buildMemoryBudgetMb: 0,
                },
                dependencies([])
            )
        ).rejects.toThrow('build memory budget must be a positive integer')
    })

    test('rejects duplicate recipes in a parallel build', async () => {
        expect(
            runPipeline(
                env,
                [recipe, recipe],
                {
                    syncBack: false,
                    ci: true,
                    buildConcurrency: 2,
                    buildMemoryBudgetMb: 8192,
                    buildCpuBudget: 4,
                },
                dependencies([])
            )
        ).rejects.toThrow('cannot include debian-12 more than once')
    })
})
