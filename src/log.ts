import pc from 'picocolors'

export const log = {
    info: (msg: string) => console.error(`${pc.cyan('•')} ${msg}`),
    step: (msg: string) => console.error(`${pc.blue('▶')} ${pc.bold(msg)}`),
    ok: (msg: string) => console.error(`${pc.green('✓')} ${msg}`),
    warn: (msg: string) => console.error(`${pc.yellow('!')} ${msg}`),
    err: (msg: string) => console.error(`${pc.red('✗')} ${msg}`),
    raw: (msg: string) => console.error(pc.dim(msg)),
}
