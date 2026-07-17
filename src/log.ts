import { log as base } from '@cofoundry/ui'
import { redactSensitive } from '@/util.ts'

export const log = {
    info: (msg: string): void => base.info(redactSensitive(msg)),
    step: (msg: string): void => base.step(redactSensitive(msg)),
    ok: (msg: string): void => base.ok(redactSensitive(msg)),
    warn: (msg: string): void => base.warn(redactSensitive(msg)),
    err: (msg: string): void => base.err(redactSensitive(msg)),
    note: (msg: string): void => base.note(redactSensitive(msg)),
    raw: (msg: string): void => base.raw(redactSensitive(msg)),
    blank: (): void => base.blank(),
    section: (title: string): void => base.section(title),
}
