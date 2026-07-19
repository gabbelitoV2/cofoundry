import pRetry, { AbortError } from 'p-retry'
import { createHash } from 'node:crypto'
import type { RecipeInfo } from '@/config.ts'
import {
    CLOUDBASE_INIT_DEFAULT_VERSION,
    VIRTIO_WIN_DEFAULT_VERSION,
    type Env,
} from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { remotePaths } from '@/build/paths.ts'
import {
    captureRemote,
    isPermanentWgetExit,
    remoteWgetCapture,
    WgetError,
} from '@/build/remote.ts'

export type PrefetchProgress = (slot: string, line: string) => void

// Either a vendor-published checksum file to match a filename pattern in, or
// a literal pinned sha256 for sources whose vendor publishes none.
export type Checksum =
    | { url: string; filenamePattern: string }
    | { sha256: string }
const ASSET_LOCK_DIR = '/var/lib/cofoundry/asset-locks'

/** A bounded lock pool avoids one persistent lock inode per historical ISO. */
export const assetLockPath = (destination: string): string =>
    `${ASSET_LOCK_DIR}/${createHash('sha256').update(destination).digest('hex').slice(0, 2)}`

const checksumCommand = (pathArg: string, checksum?: Checksum): string => {
    if (!checksum) return `test -s ${pathArg}`
    if ('sha256' in checksum) {
        return `actual=$(sha256sum ${pathArg} | awk '{print $1}') && [ "$actual" = ${shellQuote(checksum.sha256.toLowerCase())} ]`
    }
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
        // Stable temp path (no $$ PID) so a partial transfer survives to be
        // resumed. wget -c continues the same .tmp across both its own --tries
        // and the pRetry re-runs in fetchAsset, instead of re-pulling the whole
        // file from byte 0 and dying at the same point every time. Deliberately
        // no EXIT trap for the same reason: a failed attempt must leave the
        // partial in place for the next attempt to resume. On success mv
        // consumes the temp file; a completed-but-corrupt download (checksum
        // mismatch) is removed so the next attempt restarts clean rather than
        // resuming garbage that wget would consider already complete.
        //
        // -nv (not -q): keep wget's error/retry diagnostics — "Connection
        // closed at byte N. Retrying.", read-timeouts, range-response codes —
        // so a failed fetch is diagnosable from the CI log. --show-progress
        // still forces the transfer bar that -nv would otherwise suppress.
        // --read-timeout caps a stalled read so a mirror that goes silent near
        // the end (as releases.ubuntu.com does under load) is detected and
        // retried in seconds instead of hanging until the whole attempt is lost;
        // --timeout covers DNS/connect. The mirror honors HTTP Range (verified:
        // 206 + Content-Range), so each retry resumes the .tmp rather than
        // re-pulling multiple GB. A few extra --tries ride out transient drops
        // within one invocation before the outer pRetry layer takes over.
        `tmp=${shellQuote(`${destination}.tmp`)}; ` +
        `wget -nv --show-progress --progress=bar:force:noscroll -c --tries=5 --timeout=30 --read-timeout=60 --retry-connrefused --waitretry=5 -O "$tmp" ${shellQuote(url)}; ` +
        `if ${downloadedValid}; then mv -f "$tmp" ${shellQuote(destination)}; else rm -f "$tmp"; exit 1; fi`
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
    // The fetch command is idempotent (flock-serialized, checksum-validated,
    // temp download published by atomic rename), so a transient network blip is
    // safe to retry rather than failing the whole build. A permanent failure
    // (stale URL / bad invocation) aborts immediately — retrying it only
    // wastes backoff and buries the real "your URL is wrong" signal.
    await pRetry(
        async () => {
            try {
                await remoteWgetCapture(
                    env.SSH_TARGET,
                    assetFetchCommand(destination, url, checksum),
                    line => onLine?.(slot, line),
                    { url, what: `${slot} fetch` }
                )
            } catch (err) {
                if (
                    err instanceof WgetError &&
                    isPermanentWgetExit(err.exitCode)
                )
                    throw new AbortError(err)
                throw err
            }
        },
        { retries: 3, minTimeout: 1000, factor: 2 }
    )
}

// ── Pinned Windows assets ─────────────────────────────────────────────────────
// Default SHA256 pins for the default versions in src/env.ts, computed from
// the vendor downloads themselves (GitHub release asset / fedorapeople
// archive) — neither vendor publishes a usable checksum file for these
// artifacts (the virtio-win CHECKSUM file covers only the RPMs, as MD5).
const CLOUDBASE_INIT_DEFAULT_SHA256 =
    '0e7fa42e0cbc0ce7657f85730b0c6cc7afc4087a3639df0ff51a721a0be19bd5'
const VIRTIO_WIN_DEFAULT_SHA256 =
    'e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331'

/** The built-in pin only describes the default version; validating any other
 *  release against it would always fail, so an overridden version without an
 *  explicit CF_*_SHA256 falls back to the plain non-empty check. */
export const pinnedChecksum = (
    override: string | undefined,
    version: string,
    defaultVersion: string,
    defaultSha256: string
): Checksum | undefined => {
    if (override) return { sha256: override }
    return version === defaultVersion ? { sha256: defaultSha256 } : undefined
}

// Upstream names the release asset with an underscored version, e.g.
// CloudbaseInitSetup_1_1_8_x64.msi. Reusing that name as the node-side cache
// key makes the version part of the key, so a version bump refetches instead
// of reusing the previous release forever. buildWritableRepoCommand installs
// the cached file into each build copy under the version-less name the
// recipes reference.
const cloudbaseInitMsiName = (version: string): string =>
    `CloudbaseInitSetup_${version.replace(/\./g, '_')}_x64.msi`

export const cloudbaseInitMsiUrl = (version: string): string =>
    `https://github.com/cloudbase/cloudbase-init/releases/download/${version}/${cloudbaseInitMsiName(version)}`

export const cloudbaseInitMsiCachePath = (
    env: Pick<Env, 'PVE_DUMP_DIR' | 'CF_CLOUDBASE_INIT_VERSION'>
): string =>
    `${remotePaths(env).assetCache}/${cloudbaseInitMsiName(env.CF_CLOUDBASE_INIT_VERSION)}`

/** Versioned cache filename in the Proxmox ISO store. The Windows recipes
 *  receive it through the `virtio_win_iso` Packer variable, and the prune
 *  preserve-glob (src/prune/node.ts) spares every version. */
export const virtioWinIsoFilename = (
    env: Pick<Env, 'CF_VIRTIO_WIN_VERSION'>
): string => `packer-virtio-win-${env.CF_VIRTIO_WIN_VERSION}.iso`

// `virtio-win.iso` inside a versioned archive directory is that release's ISO
// under a stable per-directory name — unlike the floating stable-virtio/
// symlink, whose content changes under the same URL with every release.
export const virtioWinIsoUrl = (version: string): string =>
    `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-${version}/virtio-win.iso`

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

    const paths = remotePaths(env)
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(paths.assetCache)}`
    )
    await fetchAsset(
        env,
        cloudbaseInitMsiCachePath(env),
        cloudbaseInitMsiUrl(env.CF_CLOUDBASE_INIT_VERSION),
        'msi',
        onLine,
        pinnedChecksum(
            env.CF_CLOUDBASE_INIT_SHA256,
            env.CF_CLOUDBASE_INIT_VERSION,
            CLOUDBASE_INIT_DEFAULT_VERSION,
            CLOUDBASE_INIT_DEFAULT_SHA256
        )
    )
    await fetchAsset(
        env,
        `${paths.isoStore}/${virtioWinIsoFilename(env)}`,
        virtioWinIsoUrl(env.CF_VIRTIO_WIN_VERSION),
        'virtio',
        onLine,
        pinnedChecksum(
            env.CF_VIRTIO_WIN_SHA256,
            env.CF_VIRTIO_WIN_VERSION,
            VIRTIO_WIN_DEFAULT_VERSION,
            VIRTIO_WIN_DEFAULT_SHA256
        )
    )
}
