import { describe, expect, test } from 'bun:test'
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { list } from 'tar'
import { REPO_SYNC_EXCLUDES } from '@/build/repository.ts'
import {
    buildSnapshotInstallScript,
    createRepositoryArchive,
    hashRepositoryFiles,
    scanRepositorySnapshot,
} from '@/build/snapshot.ts'

const withRepository = async (
    run: (root: string) => Promise<void>
): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'cofoundry-snapshot-test-'))
    try {
        await run(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe('repository snapshots', () => {
    test('hashes filtered contents deterministically and notices changes', () =>
        withRepository(async root => {
            await mkdir(join(root, 'src'))
            await mkdir(join(root, '.git'))
            await mkdir(join(root, 'node_modules'))
            await writeFile(
                join(root, 'src', 'index.ts'),
                'export const n = 1\n'
            )
            await writeFile(join(root, '.env'), 'SECRET=never-upload\n')
            await writeFile(join(root, '.git', 'config'), 'private\n')
            await writeFile(join(root, 'node_modules', 'pkg.js'), 'large\n')

            const excludes = REPO_SYNC_EXCLUDES
            const firstFiles = await scanRepositorySnapshot(root, excludes)
            const firstHash = await hashRepositoryFiles(firstFiles)
            expect(firstFiles.map(file => file.relPath)).toEqual([
                'src/index.ts',
            ])

            const later = new Date(Date.now() + 60_000)
            await utimes(join(root, 'src', 'index.ts'), later, later)
            const mtimeOnlyHash = await hashRepositoryFiles(
                await scanRepositorySnapshot(root, excludes)
            )
            expect(mtimeOnlyHash).toBe(firstHash)

            await writeFile(
                join(root, 'src', 'index.ts'),
                'export const n = 2\n'
            )
            const changedHash = await hashRepositoryFiles(
                await scanRepositorySnapshot(root, excludes)
            )
            expect(changedHash).not.toBe(firstHash)
        }))

    test('creates a deterministic archive containing only filtered files', () =>
        withRepository(async root => {
            await mkdir(join(root, 'scripts'))
            await mkdir(join(root, 'dist'))
            await writeFile(join(root, 'README.md'), 'hello\n')
            await writeFile(join(root, 'scripts', 'run.sh'), '#!/bin/sh\n')
            await chmod(join(root, 'scripts', 'run.sh'), 0o755)
            await writeFile(join(root, 'dist', 'cf'), 'binary\n')
            const files = await scanRepositorySnapshot(root, ['dist'])
            const first = join(root, 'first.tar.gz')
            const second = join(root, 'second.tar.gz')

            await createRepositoryArchive(root, files, first)
            const later = new Date(Date.now() + 60_000)
            await utimes(join(root, 'README.md'), later, later)
            await createRepositoryArchive(root, files, second)

            const entries: string[] = []
            await list({
                file: first,
                onReadEntry: entry => entries.push(entry.path),
            })
            expect(entries).toEqual(['README.md', 'scripts/run.sh'])
            expect(await readFile(second)).toEqual(await readFile(first))
        }))

    test('renders a valid atomic remote install script', async () => {
        const script = buildSnapshotInstallScript({
            archive: '/dump/tmp/repo.tar.gz',
            snapshots: '/dump/cofoundry-snapshots',
            snapshot: '/dump/cofoundry-snapshots/abc123',
            work: '/dump/cofoundry-work',
            lock: '/dump/cofoundry-snapshots/.install.lock',
        })
        await execa('bash', ['-n'], { input: script })
        expect(script).toContain('flock -x 9')
        expect(script).toContain('mv -Tf "$link" "$work"')
        expect(script).toContain('chmod -R a-w "$staging"')
    })
})
