import { describe, expect, test } from 'bun:test'
import { planR2Prune, type R2Object } from '@/prune/r2.ts'

const object = (Key: string, LastModified: string): R2Object => ({
    Key,
    LastModified,
    Size: 1,
})

describe('planR2Prune', () => {
    test('keeps newest artifacts and pairs stale artifacts with sidecars', () => {
        const prefix = 'templates/linux/debian-12-amd64'
        const plan = planR2Prune(
            [
                object(`${prefix}/new.vma.zst`, '2026-02-01'),
                object(`${prefix}/new.json`, '2026-02-01'),
                object(`${prefix}/old.vma.zst`, '2026-01-01'),
                object(`${prefix}/old.json`, '2026-01-01'),
            ],
            1
        )
        expect(plan.deletions).toEqual([
            `${prefix}/old.vma.zst`,
            `${prefix}/old.json`,
        ])
    })

    test('deletes orphan sidecars', () => {
        const plan = planR2Prune(
            [object('templates/linux/debian/orphan.json', '2026-01-01')],
            1
        )
        expect(plan.orphanSidecars).toEqual([
            'templates/linux/debian/orphan.json',
        ])
    })

    test('rejects invalid keep values', () => {
        expect(() => planR2Prune([], -1)).toThrow('non-negative integer')
    })
})
