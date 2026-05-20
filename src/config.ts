import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const DEFAULT_BUILDS_DIR = new URL('../builds/', import.meta.url).pathname

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

const parseMeta = (raw: string, key: string): string | undefined => {
    const m = raw.match(new RegExp(`^#\\s*${key}\\s*:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim()
}

const parseMetaInt = (raw: string, key: string): number | undefined => {
    const v = parseMeta(raw, key)
    if (!v) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
}

const parseIsoUrl = (raw: string): string | undefined => {
    const m = raw.match(/iso_url\s*=\s*"([^"]+)"/)
    return m?.[1]
}

// Parse all variable default values from the HCL file.
const parseVarDefaults = (raw: string): Record<string, string> => {
    const vars: Record<string, string> = {}
    const blockRe = /variable\s+"([^"]+)"\s*\{([^}]+)}/g
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(raw)) !== null) {
        const defMatch = m[2]!.match(/default\s*=\s*"([^"]*)"/)
        if (defMatch) vars[m[1]!] = defMatch[1]!
    }
    return vars
}

// Expand ${var.name} references using the parsed defaults.
const resolveVarRefs = (value: string, vars: Record<string, string>): string =>
    value.replace(/\${var\.([^}]+)}/g, (orig, name: string) => vars[name] ?? orig)

const parseIsoTargetPath = (raw: string): string | undefined => {
    // Only parse the first iso_target_path (the boot ISO, not additional ISOs like VirtIO).
    const m = raw.match(/iso_target_path\s*=\s*"([^"]+)"/)
    if (!m) return undefined
    return resolveVarRefs(m[1]!, parseVarDefaults(raw))
}

export const loadRecipe = async (
    name: string,
    buildsDir: string = DEFAULT_BUILDS_DIR
): Promise<RecipeInfo> => {
    const path = join(buildsDir, `${name}.pkr.hcl`)
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

export const listRecipes = async (
    buildsDir: string = DEFAULT_BUILDS_DIR
): Promise<RecipeInfo[]> => {
    const entries = await readdir(buildsDir)
    const recipes: RecipeInfo[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.pkr.hcl')) continue
        const name = basename(entry, '.pkr.hcl')
        recipes.push(await loadRecipe(name, buildsDir))
    }
    return recipes.sort((a, b) => a.name.localeCompare(b.name))
}
