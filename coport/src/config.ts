import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_REGISTRY = 'https://images.cdn.convoypanel.com/registry.json'

interface CoportConfig {
    registry?: string
    storage?: string
}

async function readConfigFile(): Promise<CoportConfig> {
    const path = join(homedir(), '.coport', 'config.json')
    try {
        return JSON.parse(await readFile(path, 'utf8')) as CoportConfig
    } catch {
        return {}
    }
}

export interface ResolvedConfig {
    registrySource: string
    defaultStorage?: string
}

export async function resolveConfig(cliArg?: string): Promise<ResolvedConfig> {
    if (cliArg) {
        return { registrySource: cliArg }
    }
    if (process.env.COPORT_REGISTRY) {
        return { registrySource: process.env.COPORT_REGISTRY }
    }
    const fileConfig = await readConfigFile()
    return {
        registrySource: fileConfig.registry ?? DEFAULT_REGISTRY,
        defaultStorage: fileConfig.storage,
    }
}

export function isFilePath(source: string): boolean {
    return source.startsWith('/') || source.startsWith('./')
}
