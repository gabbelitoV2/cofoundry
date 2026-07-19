export const buildAttemptCount = (
    isWindows: boolean,
    keepVm: boolean,
    configured?: string | number
): number => {
    if (keepVm) return 1
    const parsed = Number.parseInt(
        String(configured ?? (isWindows ? '3' : '1')),
        10
    )
    return Math.max(1, parsed || 1)
}

export const runWithRetries = async (
    attempts: number,
    run: (attempt: number) => Promise<void>,
    onRetry?: (message: string) => void,
    cancelSignal?: AbortSignal
): Promise<void> => {
    if (!Number.isInteger(attempts) || attempts < 1)
        throw new Error('attempts must be a positive integer')
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
        // An abort (the run lease was lost) throws the signal's reason — the
        // explanatory lease-lost error — so no further attempts start.
        cancelSignal?.throwIfAborted()
        try {
            if (attempt > 1)
                onRetry?.(`[retry] build attempt ${attempt}/${attempts}`)
            await run(attempt)
            return
        } catch (error) {
            // A failure caused by the abort itself (the cancelled SSH child
            // exiting) is not a build failure: surface the abort reason
            // instead and never retry an aborted run.
            cancelSignal?.throwIfAborted()
            lastError = error
            if (attempt < attempts) {
                const message =
                    error instanceof Error
                        ? error.message.split('\n')[0]
                        : String(error)
                onRetry?.(
                    `[retry] attempt ${attempt}/${attempts} failed: ${message}`
                )
            }
        }
    }
    throw lastError
}
