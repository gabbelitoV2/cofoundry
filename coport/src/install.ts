export const qmrestore = async (
    filePath: string,
    vmid: number,
    storage: string,
    force: boolean,
    onProgress?: (pct: number) => void,
    signal?: AbortSignal
): Promise<void> => {
    const args = ['qmrestore', filePath, String(vmid), '-storage', storage]
    if (force) args.push('-force', '1')

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const abort = (): void => {
        proc.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abort, { once: true })

    const decoder = new TextDecoder()
    try {
        for await (const chunk of proc.stdout) {
            if (signal?.aborted) throw new Error('Aborted')
            const text = decoder.decode(chunk)
            const m = text.match(/progress\s+(\d+)%/i)
            if (m && onProgress) {
                onProgress(Number(m[1]))
            }
        }

        const code = await proc.exited
        if (signal?.aborted) throw new Error('Aborted')
        if (code !== 0) {
            const errText = decoder.decode(
                await new Response(proc.stderr).arrayBuffer()
            )
            throw new Error(
                `qmrestore exited with code ${code}: ${errText.trim()}`
            )
        }
    } finally {
        signal?.removeEventListener('abort', abort)
    }
}
