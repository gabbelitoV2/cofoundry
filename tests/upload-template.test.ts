import { describe, expect, test } from 'bun:test'
import {
    recipeNameFromSidecar,
    renderUploadTemplate,
    uploadVariables,
} from '@/upload/template.ts'
import type { Sidecar } from '@/upload/model.ts'

const sidecar = {
    name: 'debian-12-amd64',
    arch: 'amd64',
    group: 'debian',
    sha256: 'abc123',
    size: 1,
} as Sidecar

describe('upload templates', () => {
    test('derives the bare recipe name and compatibility aliases', () => {
        expect(recipeNameFromSidecar(sidecar)).toBe('debian-12')
        expect(uploadVariables(sidecar, '/tmp/artifact')).toMatchObject({
            file: '/tmp/artifact',
            recipe: 'debian-12',
            name: 'debian-12',
            filename: 'debian-12-amd64-abc123.vma.zst',
        })
    })

    test('replaces repeated placeholders', () => {
        expect(
            renderUploadTemplate('{{recipe}}/{{recipe}}', {
                recipe: 'debian-12',
            })
        ).toBe('debian-12/debian-12')
    })
})
