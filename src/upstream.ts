import { readFile, writeFile } from 'node:fs/promises'
import type { RecipeInfo } from './config.ts'

const CHECKSUMS_FILE = new URL('../upstream-checksums.json', import.meta.url)
    .pathname

interface UpstreamState {
    lastModified?: string
    contentLength?: string
    etag?: string
}

type ChecksumStore = Record<string, UpstreamState>

export interface CheckResult {
    name: string
    changed: boolean
    error?: string
}

export async function loadChecksums(): Promise<ChecksumStore> {
    try {
        return JSON.parse(
            await readFile(CHECKSUMS_FILE, 'utf8')
        ) as ChecksumStore
    } catch {
        return {}
    }
}

export async function saveChecksums(store: ChecksumStore): Promise<void> {
    await writeFile(CHECKSUMS_FILE, JSON.stringify(store, null, 2) + '\n')
}

async function fetchState(url: string): Promise<UpstreamState> {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) throw new Error(`HEAD ${url} → HTTP ${res.status}`)
    return {
        lastModified: res.headers.get('last-modified') ?? undefined,
        contentLength: res.headers.get('content-length') ?? undefined,
        etag: res.headers.get('etag') ?? undefined,
    }
}

function hasChanged(
    stored: UpstreamState | undefined,
    current: UpstreamState
): boolean {
    if (!stored) return true
    if (current.etag && stored.etag) return current.etag !== stored.etag
    return (
        current.lastModified !== stored.lastModified ||
        current.contentLength !== stored.contentLength
    )
}

export async function checkRecipes(
    recipes: RecipeInfo[]
): Promise<{ results: CheckResult[]; store: ChecksumStore }> {
    const store = await loadChecksums()
    const results: CheckResult[] = []

    for (const recipe of recipes) {
        if (!recipe.isoUrl) continue
        try {
            const current = await fetchState(recipe.isoUrl)
            results.push({
                name: recipe.name,
                changed: hasChanged(store[recipe.name], current),
            })
            store[recipe.name] = current
        } catch (err) {
            results.push({
                name: recipe.name,
                changed: false,
                error: String(err),
            })
        }
    }

    return { results, store }
}
