import { describe, expect, test } from 'bun:test'
import { streaming } from '../src/build/remote.ts'

describe('streaming', () => {
    test('assembles partial lines per stream without cross-contamination', async () => {
        // stdout emits a line in two chunks; stderr completes a whole line in
        // between. A shared buffer would splice the stderr line onto stdout's
        // partial ("helloworld") and mangle both; separate buffers keep them
        // whole.
        const lines: string[] = []
        await streaming(
            'bash',
            [
                '-c',
                'printf hello; sleep 0.05; printf "world\\n" >&2; sleep 0.05; printf " there\\n"',
            ],
            line => lines.push(line)
        )

        expect(lines).toContain('hello there')
        expect(lines).toContain('world')
        expect(lines.join('|')).not.toContain('helloworld')
    })

    test('flushes a trailing unterminated line from each stream', async () => {
        const lines: string[] = []
        await streaming(
            'bash',
            ['-c', 'printf out >&1; printf err >&2'],
            line => lines.push(line)
        )

        expect(lines.sort()).toEqual(['err', 'out'])
    })
})
