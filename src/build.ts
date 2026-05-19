import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'
import { captureRemote, remoteStreaming, streaming } from './build/remote.ts'
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

export const runBuild = async (env: Env, recipe: RecipeInfo): Promise<void> => {
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

    log.step(`sync repo to ${env.SSH_TARGET}:${remoteWorkDir}`)
    await streaming('rsync', [
        '-a',
        '--delete',
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=out',
        `${REPO_ROOT}`,
        `${env.SSH_TARGET}:${remoteWorkDir}/`,
    ])

    if (recipe.buildVmid) {
        log.step(`remove stale VM ${recipe.buildVmid}`)
        await captureRemote(
            env.SSH_TARGET,
            `qm stop ${recipe.buildVmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                `qm unlock ${recipe.buildVmid} >/dev/null 2>&1 || true; ` +
                `qm destroy ${recipe.buildVmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true`
        )
    }

    if (recipe.isoUrl && recipe.isoTargetPath) {
        log.step(`ensure ISO cache: ${recipe.isoTargetPath}`)
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))} && ` +
                `[ -f ${shellQuote(recipe.isoTargetPath)} ] && echo "cached" || ` +
                `wget -q -O ${shellQuote(recipe.isoTargetPath)} ${shellQuote(recipe.isoUrl)}`
        )
    }

    if (recipe.name.startsWith('windows-')) {
        log.step('pre-fetch Cloudbase-Init MSI on remote host')
        const msiDest = `${remoteWorkDir}/builds/_shared/CloudbaseInitSetup_x64.msi`
        await captureRemote(
            env.SSH_TARGET,
            `[ -f ${msiDest} ] && echo "cached" || (url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q -O ${msiDest} "$url")`
        )
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
        '-var-file',
        varsFile,
        ...buildPackerVars(env, recipe, needsStaticIp, buildBridge, buildGw),
        recipeHcl,
    ]
    const remoteEnv = buildRemoteEnv(env, remoteOutDir, remoteTmpDir)
    await remoteStreaming(
        env.SSH_TARGET,
        `${remoteEnv} ${packerArgs.join(' ')}`
    )

    if (env.CF_SKIP_SYNC_BACK) {
        log.step(`skip syncing artifacts back`)
    } else {
        log.step(`sync artifacts back`)
        await streaming('rsync', [
            '-a',
            `${env.SSH_TARGET}:${remoteOutDir}/`,
            `${env.CF_OUT_DIR}/`,
        ])
    }

    log.ok(`build ${recipe.name} completed`)
}
