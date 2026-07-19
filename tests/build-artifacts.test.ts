import { describe, expect, test } from 'bun:test'
import {
    parseRemoteArtifactList,
    selectRecipeArtifacts,
} from '@/build/artifacts.ts'

describe('artifact selection', () => {
    test('parses find output and ignores malformed rows', () => {
        expect(
            parseRemoteArtifactList(
                '100.25 debian-12-amd64.vma.zst\nnot-a-row\n101 debian-12-amd64.json\n'
            )
        ).toEqual([
            { name: 'debian-12-amd64.vma.zst', mtime: 100.25 },
            { name: 'debian-12-amd64.json', mtime: 101 },
        ])
    })

    test('selects only the current recipe and applies clock-skew slack', () => {
        const artifacts = [
            { name: 'debian-12-amd64.vma.zst', mtime: 98 },
            { name: 'debian-12-amd64.json', mtime: 99 },
            { name: 'debian-13-amd64.vma.zst', mtime: 105 },
            { name: 'debian-12-old.vma.zst', mtime: 97.9 },
        ]
        expect(selectRecipeArtifacts(artifacts, 'debian-12', 100)).toEqual([
            'debian-12-amd64.vma.zst',
            'debian-12-amd64.json',
        ])
    })
})
