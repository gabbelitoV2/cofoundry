import pRetry from 'p-retry'
import { createHash } from 'node:crypto'
import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { remotePaths } from '@/build/paths.ts'
import { captureRemote, remoteWgetCapture } from '@/build/remote.ts'

export type PrefetchProgress = (slot: string, line: string) => void

type Checksum = { url: string; filenamePattern: string }
const ASSET_LOCK_DIR = '/var/lib/cofoundry/asset-locks'

/** A bounded lock pool avoids one persistent lock inode per historical ISO. */
export const assetLockPath = (destination: string): string =>
    `${ASSET_LOCK_DIR}/${createHash('sha256').update(destination).digest('hex').slice(0, 2)}`

const checksumCommand = (pathArg: string, checksum?: Checksum): string => {
    if (!checksum) return `test -s ${pathArg}`
    return (
        `expected=$(curl -fsSL ${shellQuote(checksum.url)} 2>/dev/null | ` +
        `python3 -c ${shellQuote("import re,sys; p=re.compile(sys.argv[1]); lines=(line for line in sys.stdin if p.search(line)); line=next(lines, ''); hashes=re.findall(r'(?i)\\b[0-9a-f]{64}\\b', line); print(hashes[0].lower() if hashes else '')")} ${shellQuote(checksum.filenamePattern)} || true); ` +
        `if [ -z "$expected" ]; then test -s ${pathArg}; else ` +
        `actual=$(sha256sum ${pathArg} | awk '{print $1}') && [ "$actual" = "$expected" ]; fi`
    )
}

/** Serialize by destination, validate under the lock, and publish by rename. */
export const assetFetchCommand = (
    destination: string,
    url: string,
    checksum?: Checksum
): string => {
    const valid = checksumCommand(shellQuote(destination), checksum)
    const downloadedValid = checksumCommand('"$tmp"', checksum)
    return (
        `set -e; mkdir -p ${shellQuote(ASSET_LOCK_DIR)}; exec 9>${shellQuote(assetLockPath(destination))}; flock -x 9; ` +
        `if ${valid}; then touch ${shellQuote(destination)}; exit 0; fi; ` +
        `rm -f ${shellQuote(destination)}; ` +
        `tmp=${shellQuote(`${destination}.tmp`)}.$$; trap 'rm -f "$tmp"' EXIT; ` +
        `wget -q --show-progress --progress=bar:force:noscroll -O "$tmp" ${shellQuote(url)}; ` +
        `${downloadedValid}; mv -f "$tmp" ${shellQuote(destination)}`
    )
}

const fetchAsset = async (
    env: Env,
    destination: string,
    url: string,
    slot: string,
    onLine?: PrefetchProgress,
    checksum?: Checksum
): Promise<void> => {
    await remoteWgetCapture(
        env.SSH_TARGET,
        assetFetchCommand(destination, url, checksum),
        line => onLine?.(slot, line),
        { url, what: `${slot} fetch` }
    )
}

const fetchCloudbaseInit = async (
    env: Env,
    destination: string,
    onLine?: PrefetchProgress
): Promise<void> => {
    const command =
        `set -e; mkdir -p ${shellQuote(ASSET_LOCK_DIR)}; exec 9>${shellQuote(assetLockPath(destination))}; flock -x 9; ` +
        `if test -s ${shellQuote(destination)}; then touch ${shellQuote(destination)}; exit 0; fi; ` +
        `tmp=${shellQuote(`${destination}.tmp`)}.$$; trap 'rm -f "$tmp"' EXIT; ` +
        `url=$(curl -fsSL https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest | python3 -c "import sys,json; r=json.load(sys.stdin); print(next(a['browser_download_url'] for a in r['assets'] if 'x64' in a['name'] and a['name'].endswith('.msi')))"); ` +
        `wget -q --show-progress --progress=bar:force:noscroll -O "$tmp" "$url"; ` +
        `test -s "$tmp"; mv -f "$tmp" ${shellQuote(destination)}`
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
            onLine,
            recipe.isoChecksumUrl && recipe.isoFilenameRe
                ? {
                      url: recipe.isoChecksumUrl,
                      filenamePattern: recipe.isoFilenameRe,
                  }
                : undefined
        )
    }

    if (!recipe.name.startsWith('windows-')) return

    const assetCache = remotePaths(env).assetCache
    await captureRemote(env.SSH_TARGET, `mkdir -p ${shellQuote(assetCache)}`)
    await fetchCloudbaseInit(
        env,
        `${assetCache}/CloudbaseInitSetup_x64.msi`,
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
