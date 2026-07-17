import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createRenderer } from '../packages/ui/src/renderer.ts'

type TtyStream = PassThrough & {
    columns: number
    rows: number
    isTTY: true
}

const stripTerminalCodes = (value: string): string =>
    value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

describe('live renderer', () => {
    test('pins a complete failure above tasks that are still running', async () => {
        const stream = Object.assign(new PassThrough(), {
            columns: 48,
            rows: 100,
            isTTY: true as const,
        }) as TtyStream
        const chunks: string[] = []
        stream.on('data', chunk => chunks.push(chunk.toString()))

        const renderer = createRenderer({ stream })
        const failed = renderer.task('debian-13')
        failed.setPhase('prefetch')
        const running = renderer.task('rocky-linux-10')
        running.setPhase('build')

        await Bun.sleep(140)
        chunks.length = 0
        failed.fail(
            'iso fetch failed: server returned an error response\nhttps://example.test/a-very-long-stale-image.iso'
        )
        renderer.finish()

        const output = stripTerminalCodes(chunks.join(''))
        const unwrapped = output.replace(/\s/g, '')
        expect(output).toContain('iso fetch failed')
        expect(unwrapped).toContain('a-very-long-stale-image.iso')
        expect(output.indexOf('debian-13')).toBeLessThan(
            output.lastIndexOf('rocky-linux-10')
        )
        expect(output.match(/iso fetch failed/g)).toHaveLength(1)
    })
})
