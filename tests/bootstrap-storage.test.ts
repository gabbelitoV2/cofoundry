import { describe, expect, test } from 'bun:test'
import { parseSizeToBytes } from '@/bootstrap/storage.ts'

describe('parseSizeToBytes', () => {
    test('supports binary size suffixes', () => {
        expect(parseSizeToBytes('8G')).toBe(8 * 1024 ** 3)
        expect(parseSizeToBytes('512m')).toBe(512 * 1024 ** 2)
        expect(parseSizeToBytes('bad')).toBe(0)
    })
})
