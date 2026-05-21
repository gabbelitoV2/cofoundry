import pc from 'picocolors'
import { execa, ExecaError } from 'execa'

const BAR_WIDTH = 28

function renderBar(pct: number): string {
    const filled = Math.round((pct / 100) * BAR_WIDTH)
    return (
        '[' +
        pc.cyan('█'.repeat(filled)) +
        pc.dim('░'.repeat(BAR_WIDTH - filled)) +
        ']'
    )
}

// rsync --info=progress2 line:
// "      45.23M  82%   12.34MB/s    0:00:03 (xfr#93, to-chk=0/143)"
function parseRsyncLine(line: string): { pct: number; speed: string; eta: string } | null {
    const m = line.match(/(\d+)%\s+([\d.]+\S+)\s+(\S+)/)
    return m ? { pct: Number(m[1]), speed: m[2]!, eta: m[3]! } : null
}

export async function rsyncWithProgress(args: string[]): Promise<void> {
    // Drop --progress, add single-line overall-progress flags
    const finalArgs = [
        ...args.filter(a => a !== '--progress'),
        '--no-inc-recursive',
        '--info=progress2,name0',
    ]

    let showedBar = false
    let buf = ''

    const proc = execa('rsync', finalArgs, {
        stdout: 'pipe',
        stderr: 'inherit',
    })

    proc.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const parts = buf.split(/[\r\n]/)
        buf = parts.pop() ?? ''
        for (const raw of parts) {
            const p = parseRsyncLine(raw)
            if (!p) continue
            showedBar = true
            process.stderr.write(
                `\r  ${renderBar(p.pct)} ${String(p.pct).padStart(3)}%  ${p.speed.padEnd(11)}  ETA ${p.eta}   `
            )
        }
    })

    try {
        await proc
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(`"rsync" not found — is it installed and on your PATH?`)
        }
        throw err
    } finally {
        if (showedBar) process.stderr.write('\r\x1b[K')
    }
}
