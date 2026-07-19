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

    test('an abort mid-attempt stops retries and surfaces the abort reason', async () => {
        const abort = new AbortController()
        const reason = new Error('build run lease for debian-12 was lost')
        let calls = 0
        const promise = runWithRetries(
            3,
            async () => {
                calls++
                // Simulate the SSH child dying because the signal fired: the
                // attempt's own error must NOT win over the abort reason, and
                // no further attempts may start.
                abort.abort(reason)
                throw new Error('ssh child killed')
            },
            undefined,
            abort.signal
        )
        await expect(promise).rejects.toBe(reason)
        expect(calls).toBe(1)
    })

    test('an already-aborted signal prevents any attempt from starting', async () => {
        const abort = new AbortController()
        const reason = new Error('lease lost before the packer run started')
        abort.abort(reason)
        let calls = 0
        await expect(
            runWithRetries(
                2,
                async () => {
                    calls++
                },
                undefined,
                abort.signal
            )
        ).rejects.toBe(reason)
        expect(calls).toBe(0)
    })

    test('a signal that never aborts leaves the retry flow unchanged', async () => {
        const abort = new AbortController()
        let calls = 0
        await runWithRetries(
            2,
            async () => {
                calls++
                if (calls < 2) throw new Error('transient')
            },
            undefined,
            abort.signal
        )
        expect(calls).toBe(2)
    })
})
