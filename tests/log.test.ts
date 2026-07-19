import { describe, expect, test } from 'bun:test'
import { log } from '../src/log.ts'

describe('log', () => {
    test('exposes every log method as a callable function', () => {
        for (const level of [
            'info',
            'step',
            'ok',
            'warn',
            'err',
            'raw',
            'reveal',
        ] as const) {
            expect(typeof log[level]).toBe('function')
            expect(() => log[level]('smoke')).not.toThrow()
        }
    })

    test('writes to stderr, not stdout', () => {
        const origWrite = process.stdout.write
        let stdoutBytes = 0
        process.stdout.write = ((chunk: any) => {
            stdoutBytes += chunk.length
            return true
        }) as typeof process.stdout.write
        try {
            log.info('captured-line')
            log.warn('captured-warn')
        } finally {
            process.stdout.write = origWrite
        }
        expect(stdoutBytes).toBe(0)
    })
})
