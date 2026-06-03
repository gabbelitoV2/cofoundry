import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_REGISTRY = 'https://cofoundry.cdn.convoypanel.com/registry.json'

interface CoportConfig {
    registry?: string
    storage?: string
}

const readConfigFile = async (): Promise<CoportConfig> => {
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

export const resolveConfig = async (
    cliArg?: string
): Promise<ResolvedConfig> => {
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

export const isFilePath = (source: string): boolean =>
    source.startsWith('/') || source.startsWith('./')
