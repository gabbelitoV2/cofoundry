import { describe, expect, test } from 'bun:test'
import { createTransferProgress } from '@/build/sftp/progress.ts'
import type { TransferEvent } from '@/build/sftp/types.ts'

describe('createTransferProgress', () => {
    test('aggregates concurrent file progress and completion', () => {
        const events: TransferEvent[] = []
        const progress = createTransferProgress(
            '↑',
            [
                { relPath: 'a', size: 10 },
                { relPath: 'b', size: 20 },
            ],
            event => events.push(event)
        )
        progress.update(0, 5)
        progress.update(1, 20, true)
        expect(events.at(-1)).toMatchObject({
            doneBytes: 25,
            totalBytes: 30,
            doneFiles: 1,
            totalFiles: 2,
            currentFile: 'b',
        })
    })
})
