import { readFile } from 'node:fs/promises'
import { RegistrySchema, type Registry } from '../../src/registry/schema.ts'
import { isFilePath } from './config.ts'
import { log } from './log.ts'

export async function fetchRegistry(source: string): Promise<Registry> {
    let raw: string
    if (isFilePath(source)) {
        raw = await readFile(source, 'utf8')
    } else {
        const res = await fetch(source)
        if (!res.ok) {
            throw new Error(`Failed to fetch registry: ${res.status} ${res.statusText}`)
        }
        raw = await res.text()
    }

    const parsed = RegistrySchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
        log.error('Registry validation failed:', parsed.error.format())
        throw new Error('Invalid registry format. Try upgrading coport.')
    }

    if (parsed.data.schema_version !== '1') {
        throw new Error(`Unsupported registry schema_version: ${parsed.data.schema_version}. Upgrade coport.`)
    }

    return parsed.data
}
