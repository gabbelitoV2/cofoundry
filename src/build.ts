import { spawnSync } from 'node:child_process'
import pRetry from 'p-retry'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { shellQuote } from './util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteWgetCapture,
} from './build/remote.ts'
import { sftpUpload, sftpDownload, type OnProgress, type OnPhase } from './build/sftp.ts'
import {
    buildPackerVars,
    buildRemoteEnv,
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
    selectBridge,
} from './build/packer.ts'

export const REPO_ROOT = new URL('../', import.meta.url).pathname

const fileExists = (path: string): Promise<boolean> => Bun.file(path).exists()

export type SyncRepoOptions = {
    concurrency?: number
    onProgress?: OnProgress
    onPhase?: OnPhase
}

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
        excludes: ['.git', 'node_modules', 'out'],
        delete: true,
        concurrency: opts.concurrency ?? env.CF_UPLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
        onPhase: opts.onPhase,
    })
}

export type SyncArtifactsOptions = { concurrency?: number; onProgress?: OnProgress }

// Pulls everything in the remote out-dir back to local. Used for batched pulls.
export const syncArtifactsBack = async (
    env: Env,
    opts: SyncArtifactsOptions = {}
): Promise<void> => {
    await sftpDownload(env.SSH_TARGET, buildRemoteOutDir(env), env.CF_OUT_DIR, {
        concurrency: opts.concurrency ?? env.CF_DOWNLOAD_CONCURRENCY,
        onProgress: opts.onProgress,
    })
}

const resolveBuildGateway = async (
    env: Env,
    bridge: string,
    useBridgeAddress: boolean
): Promise<string> => {
    if (!useBridgeAddress) {
        if (!env.CF_BUILD_GW) {
            throw new Error(`CF_BUILD_GW is required for ISO installer builds on ${bridge}.`)
        }
        return env.CF_BUILD_GW
    }
    const out = await captureRemote(
        env.SSH_TARGET,
        `ip -4 -o addr show dev ${shellQuote(bridge)}`
    )
    const match = out.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//)
    if (!match) {
        throw new Error(`Could not determine IPv4 address for bridge ${bridge}.`)
    }
    return match[1]!
}

// ── Phase 1: prefetch ─────────────────────────────────────────────────────────

export type PrefetchProgress = (slot: string, line: string) => void

const remoteFileExists = async (env: Env, path: string): Promise<boolean> => {
    const out = await captureRemote(
        env.SSH_TARGET,
        `[ -f ${shellQuote(path)} ] && echo 1 || echo 0`
    )
    return out.trim() === '1'
}

export const prefetchPhase = async (
    env: Env,
    recipe: RecipeInfo,
    onLine?: PrefetchProgress
): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)

    if (recipe.isoUrl && recipe.isoTargetPath) {
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))}`
        )
        if (!(await remoteFileExists(env, recipe.isoTargetPath))) {
            const tmpPath = recipe.isoTargetPath + '.tmp'
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(tmpPath)} ${shellQuote(recipe.isoUrl)} && mv ${shellQuote(tmpPath)} ${shellQuote(recipe.isoTargetPath)}`
            await remoteWgetCapture(env.SSH_TARGET, wgetCmd, line =>
                onLine?.('iso', line)
            )
        }
    }

    if (recipe.name.startsWith('windows-')) {
        const msiDest = `${remoteWorkDir}/builds/_shared/CloudbaseInitSetup_x64.msi`
        if (!(await remoteFileExists(env, msiDest))) {
            // GitHub API can flake; retry the URL fetch + download.
            const curlAndWget = `url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(msiDest)} "$url"`
            await pRetry(
                () =>
                    remoteWgetCapture(env.SSH_TARGET, curlAndWget, line =>
                        onLine?.('msi', line)
                    ),
                { retries: 3, minTimeout: 1000, factor: 2 }
            )
        }

        const virtioIsoDest = '/var/lib/vz/template/iso/packer-virtio-win.iso'
        const virtioIsoUrl =
            'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso'
        if (!(await remoteFileExists(env, virtioIsoDest))) {
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(virtioIsoDest)} ${shellQuote(virtioIsoUrl)}`
            await remoteWgetCapture(env.SSH_TARGET, wgetCmd, line =>
                onLine?.('virtio', line)
            )
        }
    }
}

// ── Phase 2: packer build ────────────────────────────────────────────────────

export type BuildPhaseOptions = { keepVm?: boolean }

export type BuildPhaseResult = {
    /** Remote epoch (seconds) captured before packer ran. Used by syncPhase
     *  to filter out stale artifacts left by prior runs. */
    startedAt: number
}

export const buildPhase = async (
    env: Env,
    recipe: RecipeInfo,
    options: BuildPhaseOptions = {},
    onLine?: (line: string) => void
): Promise<BuildPhaseResult> => {
    const remoteWorkDir = buildRemoteWorkDir(env)
    const remoteOutDir = buildRemoteOutDir(env)
    const remoteTmpDir = buildRemoteTmpDir(env)

    // Pre-clean prior artifacts for this recipe so a partial/aborted build
    // can't leave stale `.vma.zst` or `.json` that syncPhase then pulls down.
    // Also capture the remote build-start epoch for the mtime gate below.
    const stalePrefix = `${remoteOutDir}/${recipe.name}-${recipe.arch}`
    const startedAtRaw = await captureRemote(
        env.SSH_TARGET,
        `rm -f ${shellQuote(stalePrefix + '.vma.zst')} ${shellQuote(stalePrefix + '.json')} ${shellQuote(stalePrefix + '.json.tmp')} && date +%s`
    )
    const startedAt = Number.parseInt(startedAtRaw.trim(), 10)
    if (!Number.isFinite(startedAt)) {
        throw new Error(`could not parse remote epoch: ${startedAtRaw}`)
    }
    const hasPreseed = await fileExists(`${REPO_ROOT}builds/${recipe.name}/http/preseed.cfg`)
    const hasAutoinstall = await fileExists(`${REPO_ROOT}builds/${recipe.name}/http/user-data`)
    const hasKickstart = await fileExists(`${REPO_ROOT}builds/${recipe.name}/http/ks.cfg`)
    const needsStaticIp = hasPreseed || hasAutoinstall || hasKickstart
    const useInstallerNatBridge = hasPreseed || hasAutoinstall || hasKickstart
    const buildBridge = selectBridge(env, recipe.name, hasPreseed, hasAutoinstall, hasKickstart)

    if (needsStaticIp && !env.CF_BUILD_IP) {
        throw new Error(
            `CF_BUILD_IP is required for ISO installer builds.\n` +
                `Add CF_BUILD_IP=<free-ip-on-vmbr0> CF_BUILD_GW=<gateway> to .env and retry.`
        )
    }

    const buildGw = needsStaticIp
        ? await resolveBuildGateway(env, buildBridge, useInstallerNatBridge)
        : ''

    if (recipe.buildVmid) {
        await captureRemote(
            env.SSH_TARGET,
            `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
        )
    }

    const injectEnv = [
        `RUNNER_TEMP=${shellQuote(remoteTmpDir)}`,
        `CF_BUILD_IP=${shellQuote(env.CF_BUILD_IP ?? '')}`,
        `CF_BUILD_GW=${shellQuote(buildGw)}`,
        `CF_BUILD_DNS=${shellQuote(env.CF_BUILD_DNS)}`,
    ].join(' ')
    const varsFile = (
        await captureRemote(
            env.SSH_TARGET,
            `cd ${remoteWorkDir} && ${injectEnv} bash scripts/inject-placeholders.sh ${recipe.name}`
        )
    ).trim()

    const recipeHcl = `${remoteWorkDir}/builds/${recipe.name}.pkr.hcl`

    await remoteStreaming(env.SSH_TARGET, `packer init ${recipeHcl}`, onLine)

    const packerArgs = [
        'packer',
        'build',
        '-force',
        ...(options.keepVm ? ['-on-error=abort'] : []),
        '-var-file',
        varsFile,
        ...buildPackerVars(env, recipe, needsStaticIp, buildBridge, buildGw),
        recipeHcl,
    ]
    const remoteEnv = buildRemoteEnv(env, remoteOutDir, remoteTmpDir, recipe.arch, recipe.group ?? '')

    const unregisterVmCleanup =
        recipe.buildVmid && !options.keepVm
            ? registerCleanup(() => {
                  process.stderr.write(
                      `\ncancelled — destroying build VM ${recipe.buildVmid}\n`
                  )
                  const destroyCmd =
                      `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                      `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                      `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
                  spawnSync('ssh', [env.SSH_TARGET, destroyCmd], { stdio: 'inherit' })
              })
            : undefined

    try {
        await remoteStreaming(
            env.SSH_TARGET,
            `${remoteEnv} ${packerArgs.join(' ')}`,
            onLine
        )
    } finally {
        unregisterVmCleanup?.()
    }

    return { startedAt }
}

// ── Phase 3: per-recipe artifact pull ────────────────────────────────────────

export type SyncPhaseOptions = {
    concurrency?: number
    onProgress?: OnProgress
    /** Only pull files with mtime >= this remote epoch (seconds). Filters out
     *  stale artifacts from prior runs that the current build didn't rewrite. */
    since?: number
}

// Pulls just this recipe's artifacts from the remote out-dir. Matches by the
// recipe name prefix so a parallel run for another recipe isn't accidentally
// downloaded.
export const syncPhase = async (
    env: Env,
    recipe: RecipeInfo,
    opts: SyncPhaseOptions = {}
): Promise<void> => {
    const remoteOutDir = buildRemoteOutDir(env)
    // `%T@` is the file's mtime in epoch seconds (with fractional part).
    const listOut = await captureRemote(
        env.SSH_TARGET,
        `find ${shellQuote(remoteOutDir)} -maxdepth 1 -type f -printf '%T@ %f\\n' 2>/dev/null || true`
    )
    // Slack window: tolerate small clock skew or sub-second rounding between
    // the `date +%s` we captured and the file's mtime as reported by find.
    const sinceSlack = 2
    const minMtime = opts.since !== undefined ? opts.since - sinceSlack : 0
    const matching = listOut
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
            const sp = line.indexOf(' ')
            if (sp < 0) return null
            const mtime = Number.parseFloat(line.slice(0, sp))
            const name = line.slice(sp + 1)
            return Number.isFinite(mtime) ? { name, mtime } : null
        })
        .filter((x): x is { name: string; mtime: number } => x !== null)
        .filter(
            ({ name, mtime }) =>
                (name.startsWith(recipe.name + '-') || name.startsWith(recipe.name + '.')) &&
                mtime >= minMtime
        )
        .map(x => x.name)
    if (matching.length === 0) return

    const { mkdirSync } = await import('node:fs')
    mkdirSync(env.CF_OUT_DIR, { recursive: true })

    // Pull individual files with scp via SFTP — but sftpDownload walks a dir.
    // Use sftpDownload against the out-dir but with file allow-list filter.
    // Simpler: stage matching files into a per-recipe tmpdir then download.
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
        await captureRemote(env.SSH_TARGET, `rm -rf ${shellQuote(stage)}`).catch(() => {})
    }
}
