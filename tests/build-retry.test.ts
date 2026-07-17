import { describe, expect, test } from 'bun:test'
import { buildAttemptCount, runWithRetries } from '@/build/retry.ts'

describe('build retry policy', () => {
    test('defaults Windows to three attempts and Linux to one', () => {
        expect(buildAttemptCount(true, false)).toBe(3)
        expect(buildAttemptCount(false, false)).toBe(1)
    })

    test('keep-vm always disables retries', () => {
        expect(buildAttemptCount(true, true, '9')).toBe(1)
    })

    test('retries failures and stops after success', async () => {
        let calls = 0
        const messages: string[] = []
        await runWithRetries(
            3,
            async () => {
                calls++
                if (calls < 3) throw new Error(`failure ${calls}`)
            },
            message => messages.push(message)
        )
        expect(calls).toBe(3)
        expect(messages).toHaveLength(4)
        expect(messages.at(-1)).toContain('attempt 3/3')
    })

    test('throws the final error', async () => {
        expect(
            runWithRetries(2, async attempt => {
                throw new Error(`failure ${attempt}`)
            })
        ).rejects.toThrow('failure 2')
    })
})
