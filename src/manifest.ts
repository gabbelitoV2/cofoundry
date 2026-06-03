import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import byteSize from 'byte-size'
import { execa } from 'execa'
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

const GROUPS_FILE = fileURLToPath(
    new URL('../registry.groups.json', import.meta.url)
)

const loadGroupDefs = async (): Promise<Map<string, GroupDef>> => {
    const defs: GroupDef[] = JSON.parse(await readFile(GROUPS_FILE, 'utf8'))
    return new Map(defs.map(g => [g.id, g]))
}

const assembleRegistry = (
    sidecars: Sidecar[],
    groupDefs: Map<string, GroupDef>
): Registry => {
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
            ...(s.suggested_vmid !== undefined && {
                suggested_vmid: s.suggested_vmid,
            }),
        })
    }

    const groups: Group[] = []
    for (const [id, templates] of groupMap) {
        const def = groupDefs.get(id)
        groups.push({
            id,
            display_name:
                def?.display_name ??
                id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: def?.description ?? null,
            templates,
        })
    }

    return {
        schema_version: '1',
        name: 'Cofoundry Templates',
        description: 'Proxmox VM templates built with Cofoundry',
        generated_at: new Date().toISOString(),
        groups,
    }
}

const writeRegistry = async (
    outPath: string,
    registry: Registry
): Promise<string> => {
    const parent = dirname(outPath)
    if (parent && parent !== '.') await mkdir(parent, { recursive: true })
    await writeFile(outPath, JSON.stringify(registry, null, 2) + '\n')
    const templateCount = registry.groups.reduce(
        (n, g) => n + g.templates.length,
        0
    )
    log.ok(
        `wrote ${outPath} (${templateCount} templates in ${registry.groups.length} groups)`
    )
    return outPath
}

export const buildManifest = async (
    sourceDir: string,
    outPath: string
): Promise<string> => {
    const groupDefs = await loadGroupDefs()

    const entries = await readdir(sourceDir)
    const sidecars: Sidecar[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === 'registry.json') continue
        const path = join(sourceDir, entry)
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Sidecar
        sidecars.push(parsed)
        log.info(
            `  + ${basename(entry, '.json')}  ${parsed.sha256.slice(0, 12)}…  ${byteSize(parsed.size)}`
        )
    }

    return writeRegistry(outPath, assembleRegistry(sidecars, groupDefs))
}

export interface R2Object {
    Key: string
    LastModified: string
    Size: number
}

const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeR2Prefix = (prefix: string): string => {
    const trimmed = prefix.replace(/^\/+|\/+$/g, '')
    return trimmed ? `${trimmed}/` : ''
}

export const selectNewestR2Sidecars = (
    objects: R2Object[],
    prefix: string
): Map<string, R2Object> => {
    const newest = new Map<string, R2Object>()
    const normalizedPrefix = normalizeR2Prefix(prefix)
    const escapedPrefix = escapeRegex(normalizedPrefix)
    const prefixPattern = new RegExp(`^(${escapedPrefix}[^/]+)/`)

    for (const obj of objects) {
        if (!obj.Key.endsWith('.json')) continue
        const m = obj.Key.match(prefixPattern)
        if (!m) continue
        const templatePrefix = m[1]!
        const cur = newest.get(templatePrefix)
        if (!cur || obj.LastModified > cur.LastModified) {
            newest.set(templatePrefix, obj)
        }
    }

    return newest
}

const awsS3api = async (endpoint: string, args: string[]): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3api', ...args],
        { stderr: 'inherit' }
    )
    return stdout
}

const awsS3Get = async (
    endpoint: string,
    bucket: string,
    key: string
): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3', 'cp', `s3://${bucket}/${key}`, '-'],
        { stderr: 'inherit' }
    )
    return stdout
}

/**
 * Aggregate sidecar JSONs from R2 into a registry. For each template prefix,
 * takes the newest `.json` — the registry should advertise the current artifact
 * per template, not the full history.
 */
export const buildManifestFromR2 = async (
    outPath: string,
    prefix = process.env.R2_PREFIX ?? '/'
): Promise<string> => {
    const endpoint = process.env.R2_ENDPOINT
    const bucket = process.env.R2_BUCKET
    if (!endpoint) throw new Error('R2_ENDPOINT is required for --r2 publish')
    if (!bucket) throw new Error('R2_BUCKET is required for --r2 publish')
    const normalizedPrefix = normalizeR2Prefix(prefix)

    log.step(`listing s3://${bucket}/${normalizedPrefix}`)
    const listArgs = [
        'list-objects-v2',
        '--bucket',
        bucket,
    ]
    if (normalizedPrefix) listArgs.push('--prefix', normalizedPrefix)
    const raw = await awsS3api(endpoint, listArgs)
    const parsed = raw.trim() ? JSON.parse(raw) : { Contents: [] }
    const objects: R2Object[] = parsed.Contents ?? []

    // Pick newest .json per per-template prefix.
    const newest = selectNewestR2Sidecars(objects, normalizedPrefix)

    const groupDefs = await loadGroupDefs()
    const sidecars: Sidecar[] = []
    for (const [templatePrefix, obj] of newest) {
        const body = await awsS3Get(endpoint, bucket, obj.Key)
        const parsedSidecar = JSON.parse(body) as Sidecar
        sidecars.push(parsedSidecar)
        const displayPrefix = templatePrefix.replace(
            new RegExp(`^${escapeRegex(normalizedPrefix)}`),
            ''
        )
        log.info(
            `  + ${displayPrefix}  ${parsedSidecar.sha256.slice(0, 12)}…  ${byteSize(parsedSidecar.size)}`
        )
    }

    return writeRegistry(outPath, assembleRegistry(sidecars, groupDefs))
}
