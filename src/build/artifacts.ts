import { mkdirSync } from 'node:fs'
import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { buildRemoteOutDir, buildRemoteTmpDir } from '@/build/paths.ts'
import { captureRemote } from '@/build/remote.ts'
import { sftpDownload, type OnProgress } from '@/build/sftp.ts'

export type SyncArtifactsOptions = {
    concurrency?: number
    onProgress?: OnProgress
}

export const syncArtifactsBack = async (
    env: Env,
    opts: SyncArtifactsOptions = {}
): Promise<void> => {
    await sftpDownload(env.SSH_TARGET, buildRemoteOutDir(env), env.CF_OUT_DIR, {
        concurrency: opts.concurrency ?? env.CF_DOWNLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
    })
}

export type SyncPhaseOptions = SyncArtifactsOptions & {
    since?: number
}

export type RemoteArtifact = { name: string; mtime: number }

export const parseRemoteArtifactList = (output: string): RemoteArtifact[] =>
    output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const separator = line.indexOf(' ')
            if (separator < 0) return null
            const mtime = Number.parseFloat(line.slice(0, separator))
            const name = line.slice(separator + 1)
            return Number.isFinite(mtime) ? { name, mtime } : null
        })
        .filter((item): item is RemoteArtifact => item !== null)

export const selectRecipeArtifacts = (
    artifacts: RemoteArtifact[],
    recipeName: string,
    since?: number
): string[] => {
    const minMtime = since === undefined ? 0 : since - 2
    return artifacts
        .filter(
            ({ name, mtime }) =>
                (name.startsWith(`${recipeName}-`) ||
                    name.startsWith(`${recipeName}.`)) &&
                mtime >= minMtime
        )
        .map(({ name }) => name)
}

export const syncPhase = async (
    env: Env,
    recipe: RecipeInfo,
    opts: SyncPhaseOptions = {}
): Promise<void> => {
    const remoteOutDir = buildRemoteOutDir(env)
    const listOut = await captureRemote(
        env.SSH_TARGET,
        `find ${shellQuote(remoteOutDir)} -maxdepth 1 -type f -printf '%T@ %f\\n' 2>/dev/null || true`
    )
    const matching = selectRecipeArtifacts(
        parseRemoteArtifactList(listOut),
        recipe.name,
        opts.since
    )
    if (matching.length === 0) return

    mkdirSync(env.CF_OUT_DIR, { recursive: true })
    const stage = `${buildRemoteTmpDir(env)}/sync-${recipe.name}-${Date.now()}`
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(stage)} && cd ${shellQuote(remoteOutDir)} && for f in ${matching.map(shellQuote).join(' ')}; do ln -f "$f" ${shellQuote(stage)}/"$f"; done`
    )
    try {
        await sftpDownload(env.SSH_TARGET, stage, env.CF_OUT_DIR, {
            concurrency: opts.concurrency ?? env.CF_DOWNLOAD_CONCURRENCY,
            onProgress: opts.onProgress,
        })
    } finally {
        await captureRemote(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(stage)}`
        ).catch(() => {})
    }
}
