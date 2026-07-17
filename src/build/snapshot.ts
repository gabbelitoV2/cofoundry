import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from 'tar'
import type { LocalFile } from '@/build/sftp/types.ts'
import { walkLocal } from '@/build/sftp/walk.ts'
import { shellQuote } from '@/util.ts'

export type RepositorySnapshot = {
    archivePath: string
    hash: string
    files: LocalFile[]
    cleanup: () => Promise<void>
}

export const scanRepositorySnapshot = async (
    root: string,
    excludes: string[]
): Promise<LocalFile[]> =>
    (await walkLocal(root, root, excludes)).sort((a, b) =>
        a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
    )

export const hashRepositoryFiles = async (
    files: LocalFile[]
): Promise<string> => {
    const hash = createHash('sha256')
    for (const file of files) {
        const metadata = JSON.stringify([
            file.relPath,
            file.mode & 0o7777,
            file.size,
        ])
        hash.update(`${Buffer.byteLength(metadata)}:`)
        hash.update(metadata)
        for await (const chunk of createReadStream(file.localPath)) {
            hash.update(chunk)
        }
    }
    return hash.digest('hex')
}

export const createRepositoryArchive = async (
    root: string,
    files: LocalFile[],
    archivePath: string
): Promise<void> => {
    await create(
        {
            cwd: root,
            file: archivePath,
            gzip: true,
            mtime: new Date(0),
            portable: true,
            strict: true,
        },
        files.map(file => file.relPath)
    )
}

export const createRepositorySnapshot = async (
    root: string,
    excludes: string[]
): Promise<RepositorySnapshot> => {
    const directory = await mkdtemp(join(tmpdir(), 'cofoundry-snapshot-'))
    try {
        const files = await scanRepositorySnapshot(root, excludes)
        const hash = await hashRepositoryFiles(files)
        const archivePath = join(directory, `${hash}.tar.gz`)
        await createRepositoryArchive(root, files, archivePath)
        const verifiedHash = await hashRepositoryFiles(
            await scanRepositorySnapshot(root, excludes)
        )
        if (verifiedHash !== hash) {
            throw new Error('repository changed while creating its snapshot')
        }
        return {
            archivePath,
            hash,
            files,
            cleanup: () => rm(directory, { recursive: true, force: true }),
        }
    } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
    }
}

export type SnapshotInstallPaths = {
    archive: string
    snapshots: string
    snapshot: string
    work: string
    lock: string
}

export const buildSnapshotInstallScript = (
    paths: SnapshotInstallPaths
): string => `set -euo pipefail
archive=${shellQuote(paths.archive)}
snapshots=${shellQuote(paths.snapshots)}
snapshot=${shellQuote(paths.snapshot)}
work=${shellQuote(paths.work)}
lock=${shellQuote(paths.lock)}
staging="\${snapshot}.tmp.$$"
link="\${work}.new.$$"
cleanup() {
    rm -f "$archive" "$link"
    rm -rf "$staging"
}
trap cleanup EXIT
mkdir -p "$snapshots"
(
    flock -x 9
    if [ ! -d "$snapshot" ]; then
        rm -rf "$staging"
        mkdir "$staging"
        tar -xzf "$archive" -C "$staging"
        find "$staging" -type f -name '*.sh' -exec chmod +x {} +
        chmod -R a-w "$staging"
        mv "$staging" "$snapshot"
    fi
    rm -f "$link"
    ln -s "$snapshot" "$link"
    if [ -e "$work" ] && [ ! -L "$work" ]; then
        rm -rf "$work"
    fi
    mv -Tf "$link" "$work"
) 9>"$lock"
`
