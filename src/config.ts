import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const BUILDS_DIR = new URL('../builds/', import.meta.url).pathname

export interface RecipeInfo {
    name: string
    path: string
    /** Display name from `# display: ...` comment */
    display: string
    /** VMID from `# build_vmid: <n>` comment */
    buildVmid?: number
    /** ISO URL parsed from `boot_iso { iso_url = "..." }` block */
    isoUrl?: string
    /** Resolved local path for the boot ISO on the Proxmox node */
    isoTargetPath?: string
}

export async function listRecipes(): Promise<RecipeInfo[]> {
    const entries = await readdir(BUILDS_DIR)
    const recipes: RecipeInfo[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.pkr.hcl')) continue
        const name = basename(entry, '.pkr.hcl')
        recipes.push(await loadRecipe(name))
    }
    return recipes.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadRecipe(name: string): Promise<RecipeInfo> {
    const path = join(BUILDS_DIR, `${name}.pkr.hcl`)
    const raw = await readFile(path, 'utf8')
    return {
        name,
        path,
        display: parseMeta(raw, 'display') ?? name,
        buildVmid: parseMetaInt(raw, 'build_vmid'),
        isoUrl: parseIsoUrl(raw),
        isoTargetPath: parseIsoTargetPath(raw),
    }
}

function parseMeta(raw: string, key: string): string | undefined {
    const m = raw.match(new RegExp(`^#\\s*${key}\\s*:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim()
}

function parseMetaInt(raw: string, key: string): number | undefined {
    const v = parseMeta(raw, key)
    if (!v) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
}

function parseIsoUrl(raw: string): string | undefined {
    const m = raw.match(/iso_url\s*=\s*"([^"]+)"/)
    return m?.[1]
}

const ISO_CACHE_DIR = '/var/lib/cofoundry/iso-cache'

function parseIsoTargetPath(raw: string): string | undefined {
    // Only parse the first iso_target_path (the boot ISO, not additional ISOs like VirtIO).
    const m = raw.match(/iso_target_path\s*=\s*"\$\{var\.iso_cache_dir\}\/([^"]+)"/)
    if (!m) return undefined
    return `${ISO_CACHE_DIR}/${m[1]}`
}
