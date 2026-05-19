import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import byteSize from 'byte-size'
import { log } from './log.ts'

interface Sidecar {
    name: string
    display: string
    sha256: string
    size: number
    url: string
    built_at: string
}

/**
 * Read every <name>.json sidecar in outDir, concatenate them into a single
 * images.json. Schema is intentionally minimal so downstream `downloader` can
 * grow it later without breaking older builds.
 */
export const buildManifest = async (outDir: string): Promise<string> => {
    const entries = await readdir(outDir)
    const sidecars: Sidecar[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === 'images.json') continue
        const path = join(outDir, entry)
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Sidecar
        sidecars.push(parsed)
        log.info(
            `  + ${basename(entry, '.json')}  ${parsed.sha256.slice(0, 12)}…  ${byteSize(parsed.size)}`
        )
    }
    sidecars.sort((a, b) => a.name.localeCompare(b.name))

    const manifest = {
        generated_at: new Date().toISOString(),
        templates: sidecars,
    }
    const outPath = join(outDir, 'images.json')
    await writeFile(outPath, JSON.stringify(manifest, null, 2) + '\n')
    log.ok(`wrote ${outPath} (${sidecars.length} templates)`)
    return outPath
}
