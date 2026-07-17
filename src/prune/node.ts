import { execa } from 'execa'
import { accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import { log } from '@/log.ts'
import { shellQuote } from '@/util.ts'
import { remotePaths } from '@/build/paths.ts'

const LEGACY_WORK_DIR = '/tmp/cofoundry'

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
    log.ok(`${label} ${dim('·')} ${verb} ${paths.length}`)
    for (const f of paths) log.note(f)
}

export const runClean = async (env: Env): Promise<void> => {
    const paths = remotePaths(env)
    log.section(`Clean ${dim('·')} ${accent(env.SSH_TARGET)}`)
    log.step(`removing ${LEGACY_WORK_DIR}`)
    const workSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(LEGACY_WORK_DIR, '(not present)')
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${LEGACY_WORK_DIR}`)

    log.step(`removing uploaded ISOs from ${paths.isoStore}`)
    const isos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.isoStore} -maxdepth 1 \\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
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

    log.step(`removing Packer download cache from ${paths.downloadedIsoCache}`)
    const downloadedIsoSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(paths.downloadedIsoCache)
    )
    if (downloadedIsoSize === '(absent)') {
        log.info('no Packer download cache found')
    } else {
        await ssh(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(paths.downloadedIsoCache)}`
        )
        log.info(`removed ${paths.downloadedIsoCache} (${downloadedIsoSize})`)
    }

    log.step(`removing stale dump files from ${paths.dump}`)
    const dumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 \\( -name 'vzdump-qemu-91??-*' -o -name 'vzdump-qemu-92??-*' \\) 2>/dev/null || true`
        )
    )

    if (dumps.length === 0) {
        log.info('no stale dump files found')
    } else {
        for (const f of dumps)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(`removed ${dumps.length} dump file(s)`)
    }

    log.step(`removing build data from ${paths.dump}`)
    for (const dir of [
        paths.out,
        paths.tmp,
        paths.work,
        paths.snapshots,
        paths.assetCache,
    ]) {
        const sz = await ssh(env.SSH_TARGET, sizeOrAbsent(dir))
        if (sz !== '(absent)') {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(dir)}`)
            log.info(`removed ${dir} (${sz})`)
        }
    }

    log.blank()
    log.ok('Clean complete.')
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
    const paths = remotePaths(env)
    log.section(`Prune ${dim('·')} ${accent(env.SSH_TARGET)}`)
    if (dryRun) log.warn('dry-run: no files will be deleted')

    // 1. Ephemeral Packer ISOs (any age) — packer-prefixed names and SHA-hash
    // named files from PACKER_CACHE_DIR, all landing in the Proxmox ISO store.
    log.step('ephemeral Packer ISOs in Proxmox ISO storage')
    const packerIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.isoStore} -maxdepth 1 \\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
        )
    )
    await remove(env, packerIsos, dryRun)
    report('ephemeral Packer ISOs', packerIsos, dryRun)

    // 2. Packer's local ISO download cache. These are hash-named staging files
    // under /root, separate from the final ISO storage pool copies.
    log.step(`Packer download cache in ${paths.downloadedIsoCache}`)
    const downloadedIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.downloadedIsoCache} -maxdepth 1 \\( -name '*.iso' -o -name '*.iso.lock' \\) 2>/dev/null || true`
        )
    )
    await remove(env, downloadedIsos, dryRun)
    report('Packer download cache', downloadedIsos, dryRun)

    // 3. Stale vzdump archives in the dump dir older than --days.
    // Match every VMID because installer builds use slot-derived IDs. Any dump
    // that failed to move to the artifact directory is eligible by age.
    log.step(`stale vzdump archives in ${paths.dump} older than ${days} day(s)`)
    const oldDumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name 'vzdump-qemu-*' -mtime +${days} 2>/dev/null || true`
        )
    )
    await remove(env, oldDumps, dryRun)
    report('stale vzdump archives', oldDumps, dryRun)

    // 4. Orphaned build VMs. Every build VM is named `packer-<recipe>` (the
    // vm_name in every recipe), so match by name rather than a VMID range. The
    // old range match (`9[12]xx`) silently missed the per-build VMID scheme
    // (build_vmid base * 100 + slot, e.g. 600201), so cancelled/killed builds
    // leaked VMs that nothing ever reaped. Exclude templates: a successful
    // build destroys its VM after vzdump, so a lingering `packer-*` template is
    // an intentional artifact we must not delete.
    log.step('orphaned build VMs (packer-*, excluding templates)')
    const orphans = lines(
        await ssh(
            env.SSH_TARGET,
            `for v in $(qm list 2>/dev/null | awk 'NR>1 && $2 ~ /^packer-/ {print $1}'); do ` +
                `qm config "$v" 2>/dev/null | grep -q '^template:' || echo "$v"; ` +
                `done`
        )
    )

    if (orphans.length === 0) {
        log.info('orphaned build VMs: none found')
    } else {
        const verb = dryRun ? 'would destroy' : 'destroying'
        for (const vmid of orphans) {
            log.note(`${verb} VM ${vmid}`)
            if (!dryRun) {
                await ssh(
                    env.SSH_TARGET,
                    `qm stop ${vmid} --skiplock 1 2>/dev/null || true; qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true`
                )
            }
        }
        log.ok(
            `orphaned VMs ${dim('·')} ${verb.replace('would ', '').replace('ing', 'ed')} ${orphans.length}`
        )
    }

    // 5. Content-addressed repository snapshots older than --days. Keep the
    // snapshot selected by the stable work symlink even if it is old.
    log.step(`repository snapshots older than ${days} day(s)`)
    const oldSnapshots = lines(
        await ssh(
            env.SSH_TARGET,
            `current=$(readlink -f ${shellQuote(paths.work)} 2>/dev/null || true); ` +
                `find ${shellQuote(paths.snapshots)} -mindepth 1 -maxdepth 1 -type d -mtime +${days} 2>/dev/null | ` +
                `while IFS= read -r snapshot; do [ "$snapshot" = "$current" ] || echo "$snapshot"; done`
        )
    )
    if (!dryRun) {
        for (const snapshot of oldSnapshots) {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(snapshot)}`)
        }
    }
    report('repository snapshots', oldSnapshots, dryRun)

    // 6. Current working link (only if no other process is using its target).
    log.step(`working dir ${paths.work}`)
    const workInUse = await ssh(
        env.SSH_TARGET,
        `lsof +D ${shellQuote(paths.work)} 2>/dev/null | tail -n +2 | head -1 | wc -l`
    )
    if (workInUse.trim() !== '0') {
        log.info(`${paths.work}: in use, skipping`)
    } else {
        if (dryRun) {
            const sz = await ssh(env.SSH_TARGET, sizeOrAbsent(paths.work))
            log.info(`${paths.work}: would remove (${sz})`)
        } else {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(paths.work)}`)
            log.ok(`removed ${paths.work}`)
        }
    }

    log.blank()
    log.ok(dryRun ? 'Prune dry-run complete.' : 'Prune complete.')
}
