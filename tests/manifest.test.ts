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

    test('writes registry.json with schema_version "1" and a generated_at timestamp', async () => {
        const path = await buildManifest(outDir)
        expect(path).toBe(join(outDir, 'registry.json'))

        const manifest = JSON.parse(await readFile(path, 'utf8'))
        expect(manifest.schema_version).toBe('1')
        expect(typeof manifest.generated_at).toBe('string')
        expect(() =>
            new Date(manifest.generated_at).toISOString()
        ).not.toThrow()
    })

    test('organizes templates into groups with sorted names', async () => {
        await buildManifest(outDir)
        const manifest = JSON.parse(await readFile(join(outDir, 'registry.json'), 'utf8'))

        expect(Array.isArray(manifest.groups)).toBe(true)

        const allNames = manifest.groups.flatMap((g: any) => g.templates.map((t: any) => t.name))
        expect(allNames.sort()).toEqual(['almalinux-9-amd64', 'debian-12-amd64'])
    })

    test('assigns correct group display names from registry.groups.json', async () => {
        await buildManifest(outDir)
        const manifest = JSON.parse(await readFile(join(outDir, 'registry.json'), 'utf8'))

        const debian = manifest.groups.find((g: any) => g.id === 'debian')
        expect(debian?.display_name).toBe('Debian')

        const alma = manifest.groups.find((g: any) => g.id === 'almalinux')
        expect(alma?.display_name).toBe('AlmaLinux')
    })

    test('preserves sidecar fields verbatim', async () => {
        await buildManifest(outDir)
        const manifest = JSON.parse(
            await readFile(join(outDir, 'registry.json'), 'utf8')
        )
        const allTemplates = manifest.groups.flatMap((g: any) => g.templates)
        const debian = allTemplates.find((t: any) => t.name === 'debian-12-amd64')
        expect(debian).toMatchObject({
            display: 'Debian 12 (Bookworm)',
            arch: 'amd64',
            sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
            size: 1572864000,
            suggested_vmid: 4001,
            url: 'https://example.com/debian-12.vma.zst',
            built_at: '2026-05-18T12:00:00Z',
        })
    })

    test('does not include a pre-existing registry.json as a template', async () => {
        await buildManifest(outDir) // creates registry.json
        await buildManifest(outDir) // second pass should ignore it
        const manifest = JSON.parse(
            await readFile(join(outDir, 'registry.json'), 'utf8')
        )
        const allTemplates = manifest.groups.flatMap((g: any) => g.templates)
        expect(allTemplates).toHaveLength(2)
        expect(
            allTemplates.find((t: any) => t.name === 'registry')
        ).toBeUndefined()
    })

    afterEach(async () => {
        await rm(outDir, { recursive: true, force: true })
    })
})
