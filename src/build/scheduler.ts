export type BuildResources = {
    memoryMb: number
    cores: number
}

export type BuildSchedulerOptions = {
    concurrency: number
    memoryBudgetMb?: number
    cpuBudget?: number
}

type PendingJob<T> = {
    resources: BuildResources
    work: () => Promise<T>
    onStart?: () => void
    resolve: (value: T) => void
    reject: (reason: unknown) => void
}

/**
 * Admit builds only when both the parallelism cap and the node resource
 * budgets have room. The first queued job that fits is selected so a large
 * recipe does not prevent smaller recipes from using otherwise-idle capacity.
 */
export class BuildScheduler {
    private readonly concurrency: number
    private readonly memoryBudgetMb: number
    private readonly cpuBudget: number
    private readonly queue: PendingJob<unknown>[] = []
    private running = 0
    private memoryInUseMb = 0
    private coresInUse = 0

    constructor(options: BuildSchedulerOptions) {
        this.concurrency = options.concurrency
        this.memoryBudgetMb = options.memoryBudgetMb ?? Number.POSITIVE_INFINITY
        this.cpuBudget = options.cpuBudget ?? Number.POSITIVE_INFINITY
    }

    get size(): number {
        return this.queue.length
    }

    add = <T>(
        resources: BuildResources,
        work: () => Promise<T>,
        onStart?: () => void
    ): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            this.queue.push({
                resources,
                work,
                onStart,
                resolve,
                reject,
            } as PendingJob<unknown>)
            this.drain()
        })

    private fits = (resources: BuildResources): boolean =>
        this.memoryInUseMb + resources.memoryMb <= this.memoryBudgetMb &&
        this.coresInUse + resources.cores <= this.cpuBudget

    private drain = (): void => {
        while (this.running < this.concurrency) {
            const index = this.queue.findIndex(job => this.fits(job.resources))
            if (index === -1) return
            const [job] = this.queue.splice(index, 1)
            if (!job) return

            this.running += 1
            this.memoryInUseMb += job.resources.memoryMb
            this.coresInUse += job.resources.cores
            job.onStart?.()

            void job
                .work()
                .then(job.resolve, job.reject)
                .finally(() => {
                    this.running -= 1
                    this.memoryInUseMb -= job.resources.memoryMb
                    this.coresInUse -= job.resources.cores
                    this.drain()
                })
        }
    }
}
