export const qmrestore = async (
    filePath: string,
    vmid: number,
    storage: string,
    force: boolean,
    onProgress?: (pct: number) => void
): Promise<void> => {
    const args = ['qmrestore', filePath, String(vmid), '-storage', storage]
    if (force) args.push('-force', '1')

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })

    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
        const text = decoder.decode(chunk)
        const m = text.match(/progress\s+(\d+)%/i)
        if (m && onProgress) {
            onProgress(Number(m[1]))
        }
    }

    const code = await proc.exited
    if (code !== 0) {
        const errText = decoder.decode(
            await new Response(proc.stderr).arrayBuffer()
        )
        throw new Error(`qmrestore exited with code ${code}: ${errText.trim()}`)
    }
}
