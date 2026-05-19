import { createConsola } from 'consola'

const consola = createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
})

export const log = {
    info: (msg: string) => consola.info(msg),
    step: (msg: string) => consola.start(msg),
    ok: (msg: string) => consola.success(msg),
    warn: (msg: string) => consola.warn(msg),
    err: (msg: string) => consola.error(msg),
    raw: (msg: string) => consola.log(msg),
}
