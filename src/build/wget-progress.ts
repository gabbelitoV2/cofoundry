import pc from 'picocolors'

const BAR_WIDTH = 28

function renderBar(pct: number): string {
    const filled = Math.round((pct / 100) * BAR_WIDTH)
    return '[' + pc.cyan('█'.repeat(filled)) + pc.dim('░'.repeat(BAR_WIDTH - filled)) + ']'
}

function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
}

type SlotState = {
    label: string
    pct: number
    speed: string
    eta: string
    done: boolean
    error: boolean
}

export type WgetSlotHandle = {
    onLine: (line: string) => void
    finish: () => void
    fail: () => void
}

export class MultiDownloadProgress {
    private readonly slots: SlotState[] = []
    private intervalId?: ReturnType<typeof setInterval>
    private renderedLines = 0
    private readonly isTTY = Boolean(process.stderr.isTTY)

    addSlot(label: string): WgetSlotHandle {
        const slot: SlotState = {
            label,
            pct: 0,
            speed: '',
            eta: '',
            done: false,
            error: false,
        }
        this.slots.push(slot)

        if (this.isTTY && !this.intervalId) {
            this.intervalId = setInterval(() => this.render(), 100)
        }

        return {
            onLine: (line: string) => this.parseLine(slot, line),
            finish: () => {
                slot.done = true
                slot.pct = 100
                this.checkDone()
            },
            fail: () => {
                slot.done = true
                slot.error = true
                this.checkDone()
            },
        }
    }

    private parseLine(slot: SlotState, raw: string): void {
        const line = stripAnsi(raw).trim()
        if (!line) return

        // wget bar line: "  75%[=====>     ] 900MB  90.0MB/s  eta 2s"
        const pctMatch = line.match(/^(\d+)%\[/)
        if (!pctMatch) return

        slot.pct = parseInt(pctMatch[1]!, 10)

        const speedMatch = line.match(/([\d.]+\s*[KMGT]?B\/s)/i)
        if (speedMatch) slot.speed = speedMatch[1]!.replace(/\s+/, '')

        const etaMatch = line.match(/\beta\s+(.+)$/)
        if (etaMatch) slot.eta = etaMatch[1]!.trim()

        if (!this.isTTY) {
            const label = slot.label.slice(0, 18).padEnd(18)
            process.stderr.write(
                `  ${label}  ${String(slot.pct).padStart(3)}%  ${slot.speed.padEnd(12)}  ${slot.eta ? 'eta ' + slot.eta : ''}\n`
            )
        }
    }

    private checkDone(): void {
        if (!this.slots.every(s => s.done)) return
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = undefined
        }
        if (this.isTTY) {
            this.render()
            process.stderr.write('\n')
        }
    }

    private render(): void {
        if (!this.isTTY) return
        if (this.renderedLines > 0) {
            process.stderr.write(`\x1b[${this.renderedLines}A`)
        }
        for (const slot of this.slots) {
            const label = slot.label.slice(0, 18).padEnd(18)
            let status: string
            if (slot.done) {
                status = slot.error ? pc.red('✗ failed') : pc.green('✓ done')
            } else if (slot.pct > 0) {
                const bar = renderBar(slot.pct)
                const pct = String(slot.pct).padStart(3) + '%'
                const speed = slot.speed.padEnd(11)
                const eta = slot.eta ? `eta ${slot.eta}` : ''
                status = `${bar} ${pct}  ${speed}  ${eta}`
            } else {
                status = pc.dim('waiting...')
            }
            process.stderr.write(`\r\x1b[K  ${label}  ${status}\n`)
        }
        this.renderedLines = this.slots.size
    }
}
