import { execa } from 'execa'
import type { Env } from './env.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'

export interface PruneR2Options {
    keep: number
    dryRun: boolean
}

interface R2Object {
    Key: string
    LastModified: string
    Size: number
}

const awsS3 = async (endpoint: string, args: string[]): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3api', ...args],
        { stdin: 'inherit', stderr: 'inherit' }
    )
    return stdout
}

/**
 * Per-template "keep newest N" prune over R2. The R2 lifecycle rule handles
 * age-based expiration of orphaned recipes; this keeps the per-recipe window
 * tight regardless of recipe lifetime.
 */
export const runPruneR2 = async ({
    keep,
    dryRun,
}: PruneR2Options): Promise<void> => {
    const endpoint = process.env.R2_ENDPOINT
    const bucket = process.env.R2_BUCKET
    if (!endpoint) throw new Error('R2_ENDPOINT is required for --r2 prune')
    if (!bucket) throw new Error('R2_BUCKET is required for --r2 prune')

    if (dryRun) log.warn('--dry-run: no objects will be deleted')

    log.step(`listing s3://${bucket}/templates/`)
    const raw = await awsS3(endpoint, [
        'list-objects-v2',
        '--bucket',
        bucket,
        '--prefix',
        'templates/',
    ])
    const parsed = raw.trim() ? JSON.parse(raw) : { Contents: [] }
    const objects: R2Object[] = parsed.Contents ?? []

    // Group .vma.zst by per-template prefix (templates/<name>-<arch>/).
    // Sidecars are handled as siblings: each <sha>.vma.zst pairs with <sha>.json
    // at the same prefix. Pruning the artifact also prunes its sidecar so the
    // registry can never advertise a sha whose artifact has been deleted.
    const artifactGroups = new Map<string, R2Object[]>()
    const sidecarKeys = new Set<string>()
    for (const obj of objects) {
        if (obj.Key.endsWith('.vma.zst')) {
            const m = obj.Key.match(/^(templates\/[^/]+)\//)
            if (!m) continue
            const prefix = m[1]!
            if (!artifactGroups.has(prefix)) artifactGroups.set(prefix, [])
            artifactGroups.get(prefix)!.push(obj)
        } else if (obj.Key.endsWith('.json')) {
            sidecarKeys.add(obj.Key)
        }
    }

    const deletions: string[] = []
    const liveArtifactKeys = new Set<string>()

    for (const [prefix, items] of artifactGroups) {
        items.sort((a, b) => b.LastModified.localeCompare(a.LastModified))
        const live = items.slice(0, keep)
        const stale = items.slice(keep)
        for (const obj of live) liveArtifactKeys.add(obj.Key)
        if (stale.length === 0) {
            log.info(`${prefix}: ${items.length} artifact(s), within keep=${keep}`)
            continue
        }
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(`${prefix}: ${items.length} artifact(s), ${verb} ${stale.length}`)
        for (const obj of stale) {
            log.info(`  ${obj.Key}  (${obj.LastModified})`)
            deletions.push(obj.Key)
            const sidecar = obj.Key.replace(/\.vma\.zst$/, '.json')
            if (sidecarKeys.has(sidecar)) {
                log.info(`  ${sidecar}  (paired sidecar)`)
                deletions.push(sidecar)
            }
        }
    }

    // Orphan sidecars: a `.json` whose paired `.vma.zst` is neither live nor
    // already queued for deletion. Covers prior runs that deleted artifacts
    // without their sidecars, plus failed/partial uploads.
    const queuedForDeletion = new Set(deletions)
    const orphans: string[] = []
    for (const key of sidecarKeys) {
        const artifact = key.replace(/\.json$/, '.vma.zst')
        if (liveArtifactKeys.has(artifact)) continue
        if (queuedForDeletion.has(key)) continue
        orphans.push(key)
    }
    if (orphans.length > 0) {
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(`orphan sidecars: ${verb} ${orphans.length}`)
        for (const key of orphans) {
            log.info(`  ${key}`)
            deletions.push(key)
        }
    }

    if (!dryRun) {
        for (const key of deletions) {
            await awsS3(endpoint, ['delete-object', '--bucket', bucket, '--key', key])
        }
    }

    log.ok(
        dryRun
            ? `R2 prune dry-run: ${deletions.length} object(s) would be deleted across ${artifactGroups.size} template(s)`
            : `R2 prune: deleted ${deletions.length} object(s) across ${artifactGroups.size} template(s)`
    )
}

const REMOTE_WORK_DIR = '/tmp/cofoundry'
const ISO_STORE_DIR = '/var/lib/vz/template/iso'
const DOWNLOADED_ISO_DIR = '/root/downloaded_iso_path'
const DUMP_DIR = '/var/lib/vz/dump'
const REMOTE_OUT_DIR = `${DUMP_DIR}/cofoundry-out`
const REMOTE_TMP_DIR = `${DUMP_DIR}/cofoundry-tmp`
const REMOTE_BUILD_WORK_DIR = `${DUMP_DIR}/cofoundry-work`

export interface PruneOptions {
    days: number
    dryRun: boolean
}

const ssh = async (target: string, cmd: string): Promise<string> => {
    const { stdout } = await execa('ssh', [target, cmd], {
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return stdout.trim()
}

const lines = (s: string): string[] =>
    s
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

const sizeOrAbsent = (path: string, absentLabel = '(absent)'): string =>
    `if [ -e ${shellQuote(path)} ]; then du -sh ${shellQuote(path)} | cut -f1; else echo ${shellQuote(absentLabel)}; fi`

const remove = async (
    env: Env,
    paths: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const f of paths) {
        await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
    }
}

const report = (label: string, paths: string[], dryRun: boolean): void => {
    if (paths.length === 0) {
        log.info(`${label}: none found`)
        return
    }
    const verb = dryRun ? 'would remove' : 'removed'
    log.ok(`${label}: ${verb} ${paths.length}`)
    for (const f of paths) log.info(`  ${f}`)
}

export const runClean = async (env: Env): Promise<void> => {
    log.step(`removing ${REMOTE_WORK_DIR} on ${env.SSH_TARGET}`)
    const workSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(REMOTE_WORK_DIR, '(not present)')
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)

    log.step(`removing uploaded ISOs from ${ISO_STORE_DIR}`)
    const isos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 \\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
        )
    )

    if (isos.length === 0) {
        log.info('no uploaded ISOs found')
    } else {
        const sizes = await ssh(
            env.SSH_TARGET,
            `du -sh ${isos.map(shellQuote).join(' ')} | cut -f1`
        )
        for (const f of isos)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(
            `removed ${isos.length} ISO(s) — ${sizes.split('\n').join(', ')}`
        )
    }

    log.step(`removing Packer download cache from ${DOWNLOADED_ISO_DIR}`)
    const downloadedIsoSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(DOWNLOADED_ISO_DIR)
    )
    if (downloadedIsoSize === '(absent)') {
        log.info('no Packer download cache found')
    } else {
        await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(DOWNLOADED_ISO_DIR)}`)
        log.info(`removed ${DOWNLOADED_ISO_DIR} (${downloadedIsoSize})`)
    }

    log.step(`removing stale dump files from ${DUMP_DIR}`)
    const dumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${DUMP_DIR} -maxdepth 1 \\( -name 'vzdump-qemu-91??-*' -o -name 'vzdump-qemu-92??-*' \\) 2>/dev/null || true`
        )
    )

    if (dumps.length === 0) {
        log.info('no stale dump files found')
    } else {
        for (const f of dumps)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(`removed ${dumps.length} dump file(s)`)
    }

    log.step(`removing build output dirs from ${DUMP_DIR}`)
    for (const dir of [REMOTE_OUT_DIR, REMOTE_TMP_DIR, REMOTE_BUILD_WORK_DIR]) {
        const sz = await ssh(env.SSH_TARGET, sizeOrAbsent(dir))
        if (sz !== '(absent)') {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(dir)}`)
            log.info(`removed ${dir} (${sz})`)
        }
    }

    log.ok('clean done')
}

/**
 * Folds the cleanup work that previously lived in a separate weekly cron
 * (`docs/setup.md` § "Weekly cleanup cron") into the CLI so CI can call it
 * after every build. With --dry-run, enumerates targets without deleting.
 */
export const runPrune = async (
    env: Env,
    { days, dryRun }: PruneOptions
): Promise<void> => {
    if (dryRun) log.warn('--dry-run: no files will be deleted')

    // 1. Ephemeral Packer ISOs (any age) — packer-prefixed names and SHA-hash
    // named files from PACKER_CACHE_DIR, all landing in the Proxmox ISO store.
    log.step('ephemeral Packer ISOs in Proxmox ISO storage')
    const packerIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 \\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
        )
    )
    await remove(env, packerIsos, dryRun)
    report('ephemeral Packer ISOs', packerIsos, dryRun)

    // 2. Packer's local ISO download cache. These are hash-named staging files
    // under /root, separate from the final ISO storage pool copies.
    log.step(`Packer download cache in ${DOWNLOADED_ISO_DIR}`)
    const downloadedIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${DOWNLOADED_ISO_DIR} -maxdepth 1 \( -name '*.iso' -o -name '*.iso.lock' \) 2>/dev/null || true`
        )
    )
    await remove(env, downloadedIsos, dryRun)
    report('Packer download cache', downloadedIsos, dryRun)

    // 3. Stale vzdump archives in the dump dir older than --days.
    // Catches both build-VMID-prefixed dumps (91xx/92xx) and any vzdump-qemu-*
    // that failed to move to the artifact dir.
    log.step(`stale vzdump archives in ${DUMP_DIR} older than ${days} day(s)`)
    const oldDumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${DUMP_DIR} -maxdepth 1 -name 'vzdump-qemu-*' -mtime +${days} 2>/dev/null || true`
        )
    )
    await remove(env, oldDumps, dryRun)
    report('stale vzdump archives', oldDumps, dryRun)

    // 4. Orphaned build VMs (91xx/92xx, excluding templates).
    log.step('orphaned build VMs (91xx / 92xx, excluding templates)')
    const orphans = lines(
        await ssh(
            env.SSH_TARGET,
            // `qm list` reports the template flag in column 6.
            `qm list 2>/dev/null | awk 'NR>1 && $1 ~ /^9[12][0-9][0-9]$/ && $6 != "1" {print $1}' || true`
        )
    )

    if (orphans.length === 0) {
        log.info('orphaned build VMs: none found')
    } else {
        const verb = dryRun ? 'would destroy' : 'destroying'
        for (const vmid of orphans) {
            log.info(`${verb} VM ${vmid}`)
            if (!dryRun) {
                await ssh(
                    env.SSH_TARGET,
                    `qm stop ${vmid} --skiplock 1 2>/dev/null || true; qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true`
                )
            }
        }
        log.ok(
            `orphaned VMs: ${verb.replace('would ', '').replace('ing', 'ed')} ${orphans.length}`
        )
    }

    // 5. Working dir (only if no other build appears to be using it).
    log.step(`working dir ${REMOTE_WORK_DIR}`)
    const workInUse = await ssh(
        env.SSH_TARGET,
        // pgrep for packer/rsync touching the dir; non-zero exit means none.
        `lsof +D ${REMOTE_WORK_DIR} 2>/dev/null | tail -n +2 | head -1 | wc -l`
    )
    if (workInUse.trim() !== '0') {
        log.info(`${REMOTE_WORK_DIR}: in use, skipping`)
    } else {
        if (dryRun) {
            const sz = await ssh(env.SSH_TARGET, sizeOrAbsent(REMOTE_WORK_DIR))
            log.info(`${REMOTE_WORK_DIR}: would remove (${sz})`)
        } else {
            await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)
            log.ok(`removed ${REMOTE_WORK_DIR}`)
        }
    }

    log.ok(dryRun ? 'prune dry-run done' : 'prune done')
}
