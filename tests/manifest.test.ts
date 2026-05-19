import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest } from '../src/manifest.ts'

const FIXTURES = new URL('./fixtures/sidecars/', import.meta.url).pathname

const stageFixtures = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-manifest-'))
    for (const entry of await readdir(FIXTURES)) {
        await copyFile(join(FIXTURES, entry), join(dir, entry))
    }
    return dir
}

describe('buildManifest', () => {
    let outDir: string

    beforeEach(async () => {
        outDir = await stageFixtures()
    })

    test('writes images.json with sorted templates and a generated_at timestamp', async () => {
        const path = await buildManifest(outDir)
        expect(path).toBe(join(outDir, 'images.json'))

        const manifest = JSON.parse(await readFile(path, 'utf8'))
        expect(typeof manifest.generated_at).toBe('string')
        expect(() => new Date(manifest.generated_at).toISOString()).not.toThrow()

        expect(manifest.templates.map((t: any) => t.name)).toEqual([
            'almalinux-9',
            'debian-12',
        ])
    })

    test('preserves sidecar fields verbatim', async () => {
        await buildManifest(outDir)
        const manifest = JSON.parse(await readFile(join(outDir, 'images.json'), 'utf8'))
        const debian = manifest.templates.find((t: any) => t.name === 'debian-12')
        expect(debian).toMatchObject({
            display: 'Debian 12 (Bookworm)',
            sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
            size: 1572864000,
            url: 'https://example.com/debian-12.vma.zst',
            built_at: '2026-05-18T12:00:00Z',
        })
    })

    test('does not include a pre-existing images.json as a template', async () => {
        await buildManifest(outDir) // creates images.json
        await buildManifest(outDir) // second pass should ignore it
        const manifest = JSON.parse(await readFile(join(outDir, 'images.json'), 'utf8'))
        expect(manifest.templates).toHaveLength(2)
        expect(manifest.templates.find((t: any) => t.name === 'images')).toBeUndefined()
    })

    afterEach(async () => {
        await rm(outDir, { recursive: true, force: true })
    })
})

