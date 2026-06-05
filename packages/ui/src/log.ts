import figures from 'figures'
import pc from 'picocolors'

const stream = process.stderr

const write = (line: string): void => {
    stream.write(`${line}\n`)
}

export const log = {
    info: (msg: string): void => write(`${pc.cyan(figures.info)} ${msg}`),
    step: (msg: string): void =>
        write(`${pc.cyan(figures.pointer)} ${msg}`),
    ok: (msg: string): void => write(`${pc.green(figures.tick)} ${msg}`),
    warn: (msg: string): void =>
        write(`${pc.yellow(figures.warning)} ${msg}`),
    err: (msg: string): void => write(`${pc.red(figures.cross)} ${msg}`),
    note: (msg: string): void => write(`  ${pc.dim(msg)}`),
    raw: (msg: string): void => write(msg),
    blank: (): void => write(''),
    section: (title: string): void => {
        write('')
        write(pc.bold(title))
    },
}

export const title = pc.bold
export const dim = pc.dim
export const accent = pc.cyan
export const good = pc.green
export const warn = pc.yellow
export const bad = pc.red
