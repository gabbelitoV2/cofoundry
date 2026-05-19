import { type ChildProcess, spawn } from 'node:child_process'
import type { Env } from './env.ts'
import type { RecipeInfo } from './config.ts'
import { log } from './log.ts'

let _activeChild: ChildProcess | null = null

process.on('SIGINT', () => {
    if (_activeChild) {
        log.warn('Interrupted — waiting for Packer cleanup ...')
        const child = _activeChild
        _activeChild = null
        child.once('exit', () => process.exit(130))
    } else {
        process.exit(130)
    }
})

const REPO_ROOT = new URL('../', import.meta.url).pathname

export async function runBuild(env: Env, recipe: RecipeInfo): Promise<void> {
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
        ? await resolveBuildGateway(
              env,
              buildBridge,
              useInstallerNatBridge
          )
        : ''

    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(remoteWorkDir)} ${shellQuote(remoteOutDir)} ${shellQuote(remoteTmpDir)}`
    )

    log.step(`sync repo to ${env.SSH_TARGET}:${remoteWorkDir}`)
    await spawnStreaming(
        'rsync',
        [
            '-a',
            '--delete',
            '--exclude=.git',
            '--exclude=node_modules',
            '--exclude=out',
            `${REPO_ROOT}`,
            `${env.SSH_TARGET}:${remoteWorkDir}/`,
        ],
        process.env as Record<string, string>
    )

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
        await spawnStreaming(
            'rsync',
            ['-a', `${env.SSH_TARGET}:${remoteOutDir}/`, `${env.CF_OUT_DIR}/`],
            process.env as Record<string, string>
        )
    }

    log.ok(`build ${recipe.name} completed`)
}

function buildPackerVars(
    env: Env,
    recipe: RecipeInfo,
    needsStaticIp: boolean,
    buildBridge: string,
    buildGw: string
): string[] {
    const apiUrl = `https://${env.PVE_HOST}:${env.PVE_PORT}/api2/json`
    const vars = [
        '-var',
        `proxmox_api_url=${apiUrl}`,
        '-var',
        `proxmox_username=${env.PVE_TOKEN_ID}`,
        '-var',
        `proxmox_token=${env.PVE_TOKEN_SECRET}`,
        '-var',
        `proxmox_node=${env.PVE_NODE}`,
        '-var',
        `proxmox_storage_pool=${env.CF_STORAGE}`,
        '-var',
        `proxmox_iso_storage_pool=${env.CF_ISO_STORAGE}`,
        '-var',
        `proxmox_bridge=${buildBridge}`,
    ]
    if (needsStaticIp) {
        vars.push(
            '-var',
            `build_ip=${env.CF_BUILD_IP ?? ''}`,
            '-var',
            `build_gw=${buildGw}`,
            '-var',
            `build_dns=${env.CF_BUILD_DNS}`
        )
    }
    return vars
}

function selectBridge(
    env: Env,
    recipeName: string,
    hasPreseed: boolean,
    hasAutoinstall: boolean,
    hasKickstart: boolean
): string {
    // ISO installers need early boot networking before the guest agent is
    // available, so reuse the NAT bridge that already exists for Windows.
    if (
        recipeName.startsWith('windows-') ||
        hasPreseed ||
        hasAutoinstall ||
        hasKickstart
    ) {
        return env.CF_WIN_BRIDGE
    }
    return env.CF_BRIDGE
}

async function resolveBuildGateway(
    env: Env,
    bridge: string,
    useBridgeAddress: boolean
): Promise<string> {
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
        throw new Error(`Could not determine IPv4 address for bridge ${bridge}.`)
    }
    return match[1]!
}

function buildRemoteOutDir(env: Env): string {
    return `${env.PVE_DUMP_DIR}/cofoundry-out`
}

function buildRemoteWorkDir(env: Env): string {
    return `${env.PVE_DUMP_DIR}/cofoundry-work`
}

function buildRemoteTmpDir(env: Env): string {
    return `${env.PVE_DUMP_DIR}/cofoundry-tmp`
}

function buildRemoteEnv(
    env: Env,
    remoteOutDir: string,
    remoteTmpDir: string
): string {
    // Packer runs on the PVE node, so SSH_TARGET=local tells the post-processor
    // to run vzdump directly instead of SSHing back to itself.
    const pairs: Record<string, string> = {
        SSH_TARGET: 'local',
        PVE_DUMP_DIR: env.PVE_DUMP_DIR,
        CF_OUT_DIR: remoteOutDir,
        TMPDIR: remoteTmpDir,
    }
    if (env.CF_UPLOAD_CMD) pairs.CF_UPLOAD_CMD = env.CF_UPLOAD_CMD
    if (env.CF_PUBLIC_URL_TMPL)
        pairs.CF_PUBLIC_URL_TMPL = env.CF_PUBLIC_URL_TMPL
    return Object.entries(pairs)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ')
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
}

async function fileExists(path: string): Promise<boolean> {
    try {
        const { access } = await import('node:fs/promises')
        await access(path)
        return true
    } catch {
        return false
    }
}

async function captureRemote(target: string, cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let out = ''
        const child = spawn('ssh', [target, cmd], {
            env: process.env as Record<string, string>,
            stdio: ['inherit', 'pipe', 'inherit'],
        })
        _activeChild = child
        child.stdout!.on('data', (chunk: Buffer) => {
            out += chunk.toString()
        })
        child.on('error', err => {
            _activeChild = null
            reject(err)
        })
        child.on('exit', code => {
            _activeChild = null
            if (code === 0) resolve(out)
            else
                reject(
                    new Error(`remote command exited with code ${code}: ${cmd}`)
                )
        })
    })
}

function remoteStreaming(target: string, cmd: string): Promise<void> {
    return spawnStreaming(
        'ssh',
        [target, cmd],
        process.env as Record<string, string>
    )
}

function spawnStreaming(
    cmd: string,
    args: string[],
    env: Record<string, string>
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env, stdio: 'inherit' })
        _activeChild = child
        child.on('error', (err: NodeJS.ErrnoException) => {
            _activeChild = null
            reject(
                err.code === 'ENOENT'
                    ? new Error(
                          `"${cmd}" not found — is it installed and on your PATH?`
                      )
                    : err
            )
        })
        child.on('exit', code => {
            _activeChild = null
            if (code === 0) resolve()
            else
                reject(
                    new Error(
                        `${cmd} ${args.join(' ')} exited with code ${code}`
                    )
                )
        })
    })
}
