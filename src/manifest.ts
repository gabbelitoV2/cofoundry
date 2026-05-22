import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import byteSize from 'byte-size'
import { log } from './log.ts'
import type { Registry, Group, Template } from './registry/schema.ts'

interface Sidecar {
    name: string
    display: string
    arch: string
    group: string
    sha256: string
    size: number
    suggested_vmid?: number
    url: string
    built_at: string
}

interface GroupDef {
    id: string
    display_name: string
    description?: string | null
}

const GROUPS_FILE = new URL('../registry.groups.json', import.meta.url).pathname

export const buildManifest = async (outDir: string): Promise<string> => {
    const groupDefs: GroupDef[] = JSON.parse(await readFile(GROUPS_FILE, 'utf8'))
    const groupDefMap = new Map(groupDefs.map(g => [g.id, g]))

    const entries = await readdir(outDir)
    const sidecars: Sidecar[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === 'registry.json') continue
        const path = join(outDir, entry)
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Sidecar
        sidecars.push(parsed)
        log.info(
            `  + ${basename(entry, '.json')}  ${parsed.sha256.slice(0, 12)}…  ${byteSize(parsed.size)}`
        )
    }
    sidecars.sort((a, b) => a.name.localeCompare(b.name))

    const groupMap = new Map<string, Template[]>()
    for (const s of sidecars) {
        const gid = s.group ?? 'other'
        if (!groupMap.has(gid)) groupMap.set(gid, [])
        groupMap.get(gid)!.push({
            name: s.name,
            display: s.display,
            arch: s.arch,
            sha256: s.sha256,
            size: s.size,
            url: s.url,
            built_at: s.built_at,
            ...(s.suggested_vmid !== undefined && { suggested_vmid: s.suggested_vmid }),
        })
    }

    const groups: Group[] = []
    for (const [id, templates] of groupMap) {
        const def = groupDefMap.get(id)
        groups.push({
            id,
            display_name: def?.display_name ?? id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: def?.description ?? null,
            templates,
        })
    }

    const registry: Registry = {
        schema_version: '1',
        name: 'Cofoundry Templates',
        description: 'Proxmox VM templates built with Cofoundry',
        generated_at: new Date().toISOString(),
        groups,
    }

    const outPath = join(outDir, 'registry.json')
    await writeFile(outPath, JSON.stringify(registry, null, 2) + '\n')
    log.ok(`wrote ${outPath} (${sidecars.length} templates in ${groups.length} groups)`)
    return outPath
}
