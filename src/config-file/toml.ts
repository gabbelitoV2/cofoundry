import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import {
    CONFIG_FILENAME,
    CONFIG_LOCAL_FILENAME,
    FIELD_MAP,
} from '@/config-file/model.ts'

export type Toml = Record<string, unknown>
export type MergedConfigFile = {
    merged: Toml
    origin: Map<string, 'local' | 'toml'>
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const getConfigPath = (object: Toml, dotted: string): unknown =>
    dotted
        .split('.')
        .reduce<unknown>(
            (value, part) => (isObject(value) ? value[part] : undefined),
            object
        )

export const interpolateConfigValue = (
    raw: string,
    environment: NodeJS.ProcessEnv = process.env
): { value?: string; interpolated: boolean } => {
    if (!raw.includes('${')) return { value: raw, interpolated: false }
    let missing = false
    const value = raw.replace(
        /\$\{([A-Z_][A-Z0-9_]*)\}/g,
        (_, name: string) => {
            const resolved = environment[name]
            if (!resolved) missing = true
            return resolved ?? ''
        }
    )
    return { value: missing ? undefined : value, interpolated: true }
}

const readToml = (path: string): Toml | undefined => {
    let raw: string
    try {
        raw = readFileSync(path, 'utf8')
    } catch {
        return undefined
    }
    try {
        return parse(raw) as Toml
    } catch (error) {
        throw new Error(
            `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

const deepMerge = (base: Toml, overlay: Toml): Toml => {
    const output: Toml = { ...base }
    for (const [key, value] of Object.entries(overlay)) {
        const previous = output[key]
        output[key] =
            isObject(previous) && isObject(value)
                ? deepMerge(previous, value)
                : value
    }
    return output
}

export const loadMergedConfig = (cwd: string): MergedConfigFile | undefined => {
    const base = readToml(join(cwd, CONFIG_FILENAME))
    const local = readToml(join(cwd, CONFIG_LOCAL_FILENAME))
    if (!base && !local) return undefined

    const origin = new Map<string, 'local' | 'toml'>()
    for (const [path] of FIELD_MAP) {
        if (local && getConfigPath(local, path) !== undefined)
            origin.set(path, 'local')
        else if (base && getConfigPath(base, path) !== undefined)
            origin.set(path, 'toml')
    }
    return { merged: deepMerge(base ?? {}, local ?? {}), origin }
}
