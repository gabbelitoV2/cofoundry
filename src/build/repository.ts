import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { captureRemote, remoteStreamingScript } from '@/build/remote.ts'
import { sftpUploadFile, type OnPhase, type OnProgress } from '@/build/sftp.ts'
import {
    buildRemoteOutDir,
    buildRemoteSnapshotDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
    remotePaths,
} from '@/build/paths.ts'
import {
    buildSnapshotInstallScript,
    createRepositorySnapshot,
} from '@/build/snapshot.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export type SyncRepoOptions = {
    onProgress?: OnProgress
    onPhase?: OnPhase
}

export const REPO_SYNC_EXCLUDES = [
    '.git',
    '.claude',
    '.idea',
    'node_modules',
    'out',
    'dist',
    '.env',
    '.env.local',
    'cofoundry.local.toml',
    '.sbx/tailscale.env',
    '*.log',
    '.DS_Store',
]

export const syncRepoToRemote = async (
    env: Env,
    opts: SyncRepoOptions = {}
): Promise<void> => {
    const phase = opts.onPhase ?? (() => {})
    phase('creating content snapshot')
    const snapshot = await createRepositorySnapshot(
        REPO_ROOT,
        REPO_SYNC_EXCLUDES
    )
    const paths = remotePaths(env)
    const remoteArchive = `${paths.tmp}/repo-${snapshot.hash}-${randomUUID()}.tar.gz`
    try {
        const remoteSnapshot = buildRemoteSnapshotDir(env, snapshot.hash)
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(buildRemoteOutDir(env))} ${shellQuote(buildRemoteTmpDir(env))} ${shellQuote(paths.snapshots)}`
        )
        const exists = (
            await captureRemote(
                env.SSH_TARGET,
                `[ -d ${shellQuote(remoteSnapshot)} ] && echo 1 || echo 0`
            )
        ).trim()
        if (exists !== '1') {
            phase(
                `uploading snapshot (${snapshot.files.length} files, ${snapshot.hash.slice(0, 12)})`
            )
            await sftpUploadFile(
                env.SSH_TARGET,
                snapshot.archivePath,
                remoteArchive,
                opts.onProgress
            )
        } else {
            phase(`snapshot already present (${snapshot.hash.slice(0, 12)})`)
        }
        phase('activating snapshot')
        await remoteStreamingScript(
            env.SSH_TARGET,
            buildSnapshotInstallScript({
                archive: remoteArchive,
                snapshots: paths.snapshots,
                snapshot: remoteSnapshot,
                work: buildRemoteWorkDir(env),
                lock: `${paths.snapshots}/.install.lock`,
            })
        )
    } finally {
        await captureRemote(
            env.SSH_TARGET,
            `rm -f ${shellQuote(remoteArchive)}`
        ).catch(() => {})
        await snapshot.cleanup()
    }
}
