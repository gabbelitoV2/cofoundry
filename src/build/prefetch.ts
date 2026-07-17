import pRetry from 'p-retry'
import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { buildRemoteWorkDir } from '@/build/paths.ts'
import { captureRemote, remoteWgetCapture } from '@/build/remote.ts'

export type PrefetchProgress = (slot: string, line: string) => void

const remoteFileExists = async (env: Env, path: string): Promise<boolean> => {
    const out = await captureRemote(
        env.SSH_TARGET,
        `[ -f ${shellQuote(path)} ] && echo 1 || echo 0`
    )
    return out.trim() === '1'
}

const fetchAsset = async (
    env: Env,
    destination: string,
    url: string,
    slot: string,
    onLine?: PrefetchProgress
): Promise<void> => {
    if (await remoteFileExists(env, destination)) return
    const tmp = `${destination}.tmp`
    await remoteWgetCapture(
        env.SSH_TARGET,
        `wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(tmp)} ${shellQuote(url)} && mv ${shellQuote(tmp)} ${shellQuote(destination)}`,
        line => onLine?.(slot, line),
        { url, what: `${slot} fetch` }
    )
}

const fetchCloudbaseInit = async (
    env: Env,
    destination: string,
    onLine?: PrefetchProgress
): Promise<void> => {
    if (await remoteFileExists(env, destination)) return
    const command = `url=$(curl -s https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))") && wget -q --show-progress --progress=bar:force:noscroll -O ${shellQuote(destination)} "$url"`
    await pRetry(
        () =>
            remoteWgetCapture(
                env.SSH_TARGET,
                command,
                line => onLine?.('msi', line),
                { what: 'cloudbase-init msi fetch' }
            ),
        { retries: 3, minTimeout: 1000, factor: 2 }
    )
}

export const prefetchPhase = async (
    env: Env,
    recipe: RecipeInfo,
    onLine?: PrefetchProgress
): Promise<void> => {
    if (recipe.isoUrl && recipe.isoTargetPath) {
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))}`
        )
        await fetchAsset(
            env,
            recipe.isoTargetPath,
            recipe.isoUrl,
            'iso',
            onLine
        )
    }

    if (!recipe.name.startsWith('windows-')) return

    await fetchCloudbaseInit(
        env,
        `${buildRemoteWorkDir(env)}/builds/_shared/CloudbaseInitSetup_x64.msi`,
        onLine
    )
    await fetchAsset(
        env,
        '/var/lib/vz/template/iso/packer-virtio-win.iso',
        'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso',
        'virtio',
        onLine
    )
}
