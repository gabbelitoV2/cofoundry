import { spawnSync } from 'node:child_process'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteWgetCapture,
} from './build/remote.ts'
import { MultiDownloadProgress } from './build/wget-progress.ts'
import { sftpUpload, sftpDownload } from './build/sftp.ts'
import {
    buildPackerVars,
    buildRemoteEnv,
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
    selectBridge,
} from './build/packer.ts'

const REPO_ROOT = new URL('../', import.meta.url).pathname

const fileExists = (path: string): Promise<boolean> => Bun.file(path).exists()

type RunBuildOptions = {
    syncBack?: boolean
    skipSync?: boolean
    skipPrefetch?: boolean
    keepVm?: boolean
}

const shouldSyncBack = (env: Env, options?: RunBuildOptions): boolean =>
    options?.syncBack ?? !env.CF_SKIP_SYNC_BACK

export const syncRepoToRemote = async (env: Env): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(remoteWorkDir)} ${shellQuote(buildRemoteOutDir(env))} ${shellQuote(buildRemoteTmpDir(env))}`
    )
    log.step(`sync repo to ${env.SSH_TARGET}:${remoteWorkDir}`)
    await sftpUpload(env.SSH_TARGET, REPO_ROOT, remoteWorkDir, {
        excludes: ['.git', 'node_modules', 'out'],
        delete: true,
    })
}

export const syncArtifactsBack = async (env: Env): Promise<void> => {
    log.step(`sync artifacts back`)
    await sftpDownload(env.SSH_TARGET, buildRemoteOutDir(env), env.CF_OUT_DIR)
}

const resolveBuildGateway = async (
    env: Env,
    bridge: string,
    useBridgeAddress: boolean
): Promise<string> => {
    if (!useBridgeAddress) {
        if (!env.CF_BUILD_GW) {
            throw new Error(
                `CF_BUILD_GW is required for ISO installer builds on ${bridge}.`
            )
        }
        return env.CF_BUILD_GW
    }

    const out = await captureRemote(
        env.SSH_TARGET,
        `ip -4 -o addr show dev ${shellQuote(bridge)}`
    )
    const match = out.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//)
    if (!match) {
        throw new Error(
            `Could not determine IPv4 address for bridge ${bridge}.`
        )
    }
    return match[1]!
}

export const prefetchRecipeAssets = async (
    env: Env,
    recipe: RecipeInfo,
    tracker?: MultiDownloadProgress
): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)

    if (recipe.isoUrl && recipe.isoTargetPath) {
        log.step(`ensure ISO cache: ${recipe.isoTargetPath}`)
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))}`
        )
        const isoCached =
            (
                await captureRemote(
                    env.SSH_TARGET,
                    `[ -f ${shellQuote(recipe.isoTargetPath)} ] && echo 1 || echo 0`
                )
            ).trim() === '1'
        if (!isoCached) {
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(recipe.isoTargetPath)} ${shellQuote(recipe.isoUrl)}`
            const slot = tracker?.addSlot(recipe.name)
            try {
                await remoteWgetCapture(env.SSH_TARGET, wgetCmd, line => slot?.onLine(line))
                slot?.finish()
            } catch (err) {
                slot?.fail()
                throw err
            }
        }
    }

    if (recipe.name.startsWith('windows-')) {
        if (!tracker) log.step('pre-fetch Cloudbase-Init MSI on remote host')
        const msiDest = `${remoteWorkDir}/builds/_shared/CloudbaseInitSetup_x64.msi`
        const msiCached =
            (
                await captureRemote(
                    env.SSH_TARGET,
                    `[ -f ${shellQuote(msiDest)} ] && echo 1 || echo 0`
                )
            ).trim() === '1'
        if (!msiCached) {
            const curlAndWget = `url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(msiDest)} "$url"`
            const slotLabel = recipe.name.replace('windows-server-', 'win-') + ' msi'
            const slot = tracker?.addSlot(slotLabel)
            try {
                await remoteWgetCapture(env.SSH_TARGET, curlAndWget, line => slot?.onLine(line))
                slot?.finish()
            } catch (err) {
                slot?.fail()
                throw err
            }
        }

        const virtioIsoDest = '/var/lib/vz/template/iso/packer-virtio-win.iso'
        const virtioIsoUrl = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso'
        const virtioCached =
            (
                await captureRemote(
                    env.SSH_TARGET,
                    `[ -f ${shellQuote(virtioIsoDest)} ] && echo 1 || echo 0`
                )
            ).trim() === '1'
        if (!virtioCached) {
            const wgetCmd = `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(virtioIsoDest)} ${shellQuote(virtioIsoUrl)}`
            const slot = tracker?.addSlot('virtio-win iso')
            try {
                await remoteWgetCapture(env.SSH_TARGET, wgetCmd, line => slot?.onLine(line))
                slot?.finish()
            } catch (err) {
                slot?.fail()
                throw err
            }
        }
    }
}

export const runBuild = async (
    env: Env,
    recipe: RecipeInfo,
    options?: RunBuildOptions
): Promise<void> => {
    const remoteWorkDir = buildRemoteWorkDir(env)
    const remoteOutDir = buildRemoteOutDir(env)
    const remoteTmpDir = buildRemoteTmpDir(env)
    const hasPreseed = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/preseed.cfg`
    )
    const hasAutoinstall = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/user-data`
    )
    const hasKickstart = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/ks.cfg`
    )
    const needsStaticIp = hasPreseed || hasAutoinstall || hasKickstart
    const useInstallerNatBridge = hasPreseed || hasAutoinstall || hasKickstart
    const buildBridge = selectBridge(
        env,
        recipe.name,
        hasPreseed,
        hasAutoinstall,
        hasKickstart
    )

    if (needsStaticIp && !env.CF_BUILD_IP) {
        throw new Error(
            `CF_BUILD_IP is required for ISO installer builds.\n` +
                `Add CF_BUILD_IP=<free-ip-on-vmbr0> CF_BUILD_GW=<gateway> to .env and retry.`
        )
    }

    const buildGw = needsStaticIp
        ? await resolveBuildGateway(env, buildBridge, useInstallerNatBridge)
        : ''

    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(remoteWorkDir)} ${shellQuote(remoteOutDir)} ${shellQuote(remoteTmpDir)}`
    )

    if (!options?.skipSync) {
        log.step(`sync repo to ${env.SSH_TARGET}:${remoteWorkDir}`)
        await sftpUpload(env.SSH_TARGET, REPO_ROOT, remoteWorkDir, {
            excludes: ['.git', 'node_modules', 'out'],
            delete: true,
        })
    }

    if (recipe.buildVmid) {
        log.step(`remove stale VM ${recipe.buildVmid}`)
        await captureRemote(
            env.SSH_TARGET,
            `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
        )
    }

    if (!options?.skipPrefetch) {
        await prefetchRecipeAssets(env, recipe, new MultiDownloadProgress())
    }

    log.step(`inject placeholders for ${recipe.name}`)
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

    log.step(`packer init ${recipe.name}`)
    await remoteStreaming(env.SSH_TARGET, `packer init ${recipeHcl}`)

    log.step(`packer build ${recipe.name}`)
    const packerArgs = [
        'packer',
        'build',
        '-force',
        ...(options?.keepVm ? ['-on-error=abort'] : []),
        '-var-file',
        varsFile,
        ...buildPackerVars(env, recipe, needsStaticIp, buildBridge, buildGw),
        recipeHcl,
    ]
    const remoteEnv = buildRemoteEnv(env, remoteOutDir, remoteTmpDir, recipe.arch, recipe.group ?? '')

    const unregisterVmCleanup =
        recipe.buildVmid && !options?.keepVm
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
            `${remoteEnv} ${packerArgs.join(' ')}`
        )
    } finally {
        unregisterVmCleanup?.()
    }

    if (!shouldSyncBack(env, options)) {
        log.step(`skip syncing artifacts back`)
    } else {
        await syncArtifactsBack(env)
    }

    log.ok(`build ${recipe.name} completed`)
}
