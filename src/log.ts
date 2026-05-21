import { createConsola } from 'consola'
import { redactSensitive } from './util.ts'

const consola = createConsola({
    stdout: process.stderr,
    stderr: process.stderr,
})

export const log = {
    info: (msg: string) => consola.info(redactSensitive(msg)),
    step: (msg: string) => consola.start(redactSensitive(msg)),
    ok: (msg: string) => consola.success(redactSensitive(msg)),
    warn: (msg: string) => consola.warn(redactSensitive(msg)),
    err: (msg: string) => consola.error(redactSensitive(msg)),
    raw: (msg: string) => consola.log(redactSensitive(msg)),
}
