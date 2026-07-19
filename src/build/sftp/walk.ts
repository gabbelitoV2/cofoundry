import { readdir, stat } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import type SftpClient from 'ssh2-sftp-client'
import type { LocalFile, RemoteFile } from '@/build/sftp/types.ts'

export const matchesExclude = (
    relPath: string,
    excludes: string[]
): boolean => {
    const parts = relPath.split('/')
    return excludes.some(exclude => {
        if (exclude.startsWith('*.')) return relPath.endsWith(exclude.slice(1))
        if (exclude.includes('/'))
            return relPath === exclude || relPath.startsWith(`${exclude}/`)
        return parts.some(part => part === exclude)
    })
}

export const walkLocal = async (
    directory: string,
    base: string,
    excludes: string[]
): Promise<LocalFile[]> => {
    const results: LocalFile[] = []
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
        const full = join(directory, entry.name)
        const rel = relative(base, full).replace(/\\/g, '/')
        if (matchesExclude(rel, excludes)) continue
        if (entry.isDirectory())
            results.push(...(await walkLocal(full, base, excludes)))
        else if (entry.isFile()) {
            const info = await stat(full)
            results.push({
                localPath: full,
                relPath: rel,
                size: info.size,
                mode: info.mode,
            })
        }
    }
    return results
}

export const walkRemote = async (
    client: SftpClient,
    directory: string,
    base: string
): Promise<RemoteFile[]> => {
    const results: RemoteFile[] = []
    const entries = await client.list(directory)
    for (const entry of entries) {
        const remotePath = posix.join(directory, entry.name)
        const relPath = posix.relative(base, remotePath)
        if (entry.type === 'd')
            results.push(...(await walkRemote(client, remotePath, base)))
        else
            results.push({
                remotePath,
                relPath,
                size: entry.size,
                mtimeMs: entry.modifyTime,
            })
    }
    return results
}
