import { describe, expect, test } from 'bun:test'
import { BuildScheduler } from '@/build/scheduler.ts'

describe('BuildScheduler', () => {
    test('admits jobs only while RAM and CPU budgets fit', async () => {
        const scheduler = new BuildScheduler({
            concurrency: 4,
            memoryBudgetMb: 8192,
            cpuBudget: 4,
        })
        const releases: (() => void)[] = []
        let active = 0
        let peak = 0
        const run = async (): Promise<void> => {
            active += 1
            peak = Math.max(peak, active)
            await new Promise<void>(resolve => releases.push(resolve))
            active -= 1
        }

        const jobs = [
            scheduler.add({ memoryMb: 4096, cores: 2 }, run),
            scheduler.add({ memoryMb: 4096, cores: 2 }, run),
            scheduler.add({ memoryMb: 4096, cores: 2 }, run),
        ]
        await Bun.sleep(0)
        expect(active).toBe(2)
        expect(scheduler.size).toBe(1)

        releases.shift()?.()
        await Bun.sleep(0)
        expect(active).toBe(2)
        expect(peak).toBe(2)

        for (const release of releases) release()
        await Promise.all(jobs)
    })

    test('lets a smaller queued build use available capacity', async () => {
        const scheduler = new BuildScheduler({
            concurrency: 3,
            memoryBudgetMb: 8192,
            cpuBudget: 4,
        })
        const releases: (() => void)[] = []
        const started: string[] = []
        const run = (name: string) => async (): Promise<void> => {
            started.push(name)
            await new Promise<void>(resolve => releases.push(resolve))
        }

        const jobs = [
            scheduler.add({ memoryMb: 6144, cores: 3 }, run('large-1')),
            scheduler.add({ memoryMb: 6144, cores: 3 }, run('large-2')),
            scheduler.add({ memoryMb: 2048, cores: 1 }, run('small')),
        ]
        await Bun.sleep(0)
        expect(started).toEqual(['large-1', 'small'])

        for (const release of releases) release()
        await Bun.sleep(0)
        releases.at(-1)?.()
        await Promise.all(jobs)
    })
})
