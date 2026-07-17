import { fileURLToPath } from 'node:url'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { captureRemote } from '@/build/remote.ts'
import { sftpUpload, type OnPhase, type OnProgress } from '@/build/sftp.ts'
import {
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
} from '@/build/paths.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export type SyncRepoOptions = {
    concurrency?: number
    onProgress?: OnProgress
    onPhase?: OnPhase
}

const REPO_SYNC_EXCLUDES = [
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
    const remoteWorkDir = buildRemoteWorkDir(env)
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(remoteWorkDir)} ${shellQuote(buildRemoteOutDir(env))} ${shellQuote(buildRemoteTmpDir(env))}`
    )
    await sftpUpload(env.SSH_TARGET, REPO_ROOT, remoteWorkDir, {
        excludes: REPO_SYNC_EXCLUDES,
        delete: true,
        concurrency: opts.concurrency ?? env.CF_UPLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
        onPhase: opts.onPhase,
    })
    await captureRemote(
        env.SSH_TARGET,
        `find ${shellQuote(remoteWorkDir)} -name '*.sh' -exec chmod +x {} +`
    )
}
