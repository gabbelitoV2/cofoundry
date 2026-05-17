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
const REMOTE_DIR = '/tmp/cofoundry'

export async function runBuild(env: Env, recipe: RecipeInfo): Promise<void> {
    const hasPreseed = await fileExists(
        `${REPO_ROOT}builds/${recipe.name}/http/preseed.cfg`
    )

    if (hasPreseed && !env.CF_BUILD_IP) {
        throw new Error(
            `CF_BUILD_IP is required for preseed-based builds.\n` +
                `Add CF_BUILD_IP=<free-ip-on-vmbr0> CF_BUILD_GW=<gateway> to .env and retry.`
        )
    }

    log.step(`sync repo to ${env.SSH_TARGET}:${REMOTE_DIR}`)
    await spawnStreaming(
        'rsync',
        [
            '-a',
            '--delete',
            '--exclude=.git',
            '--exclude=node_modules',
            '--exclude=out',
            `${REPO_ROOT}`,
            `${env.SSH_TARGET}:${REMOTE_DIR}/`,
        ],
        process.env as Record<string, string>
    )

    if (recipe.isoUrl && recipe.isoTargetPath) {
        log.step(`ensure ISO cache: ${recipe.isoTargetPath}`)
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))} && ` +
            `[ -f ${shellQuote(recipe.isoTargetPath)} ] && echo "cached" || ` +
            `wget -q --show-progress -O ${shellQuote(recipe.isoTargetPath)} ${shellQuote(recipe.isoUrl)}`
        )
    }

    if (recipe.name.startsWith('windows-')) {
        log.step('pre-fetch Cloudbase-Init MSI on remote host')
        const msiDest = `${REMOTE_DIR}/builds/_shared/CloudbaseInitSetup_x64.msi`
        await captureRemote(
            env.SSH_TARGET,
            `[ -f ${msiDest} ] && echo "cached" || (url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q -O ${msiDest} "$url")`
        )
    }

    log.step(`inject placeholders for ${recipe.name}`)
    const varsFile = (
        await captureRemote(
            env.SSH_TARGET,
            `cd ${REMOTE_DIR} && bash scripts/inject-placeholders.sh ${recipe.name}`
        )
    ).trim()

    const recipeHcl = `${REMOTE_DIR}/builds/${recipe.name}.pkr.hcl`

    log.step(`packer init ${recipe.name}`)
    await remoteStreaming(env.SSH_TARGET, `packer init ${recipeHcl}`)

    log.step(`packer build ${recipe.name}`)
    const packerArgs = [
        'packer',
        'build',
        '-force',
        '-var-file',
        varsFile,
        ...buildPackerVars(env, recipe, hasPreseed),
        recipeHcl,
    ]
    const remoteEnv = buildRemoteEnv(env)
    await remoteStreaming(
        env.SSH_TARGET,
        `${remoteEnv} ${packerArgs.join(' ')}`
    )

    log.step(`sync artifacts back`)
    await spawnStreaming(
        'rsync',
        ['-a', `${env.SSH_TARGET}:${REMOTE_DIR}/out/`, `${env.CF_OUT_DIR}/`],
        process.env as Record<string, string>
    )

    log.ok(`build ${recipe.name} completed`)
}

function buildPackerVars(
    env: Env,
    recipe: RecipeInfo,
    hasPreseed: boolean
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
        `proxmox_bridge=${recipe.name.startsWith('windows-') ? env.CF_WIN_BRIDGE : env.CF_BRIDGE}`,
    ]
    if (hasPreseed) {
        vars.push(
            '-var',
            `build_ip=${env.CF_BUILD_IP ?? ''}`,
            '-var',
            `build_gw=${env.CF_BUILD_GW ?? ''}`,
            '-var',
            `build_dns=${env.CF_BUILD_DNS}`
        )
    }
    return vars
}

function buildRemoteEnv(env: Env): string {
    // Packer runs on the PVE node, so SSH_TARGET=local tells the post-processor
    // to run vzdump directly instead of SSHing back to itself.
    const pairs: Record<string, string> = {
        SSH_TARGET: 'local',
        PVE_DUMP_DIR: env.PVE_DUMP_DIR,
        CF_OUT_DIR: `${REMOTE_DIR}/out`,
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
