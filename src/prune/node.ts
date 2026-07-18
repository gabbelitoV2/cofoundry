import { execa } from 'execa'
import { accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import { log } from '@/log.ts'
import { shellQuote } from '@/util.ts'
import { remotePaths } from '@/build/paths.ts'
import { destroyVmCommand } from '@/build/vm.ts'

const LEGACY_WORK_DIR = '/tmp/cofoundry'

// Persistent cache prefetch re-uses across Windows builds. It lives in the ISO
// store under a `packer-` prefix, so the ephemeral-ISO sweep matches it by
// accident; routine prunes must skip it to avoid forcing a ~700MB re-download
// every cycle. See src/build/prefetch.ts.
const VIRTIO_WIN_ISO = 'packer-virtio-win.iso'

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

// rm -rf each path (directories and symlinks, which `remove`'s rm -f can't take).
const removeDirs = async (
    env: Env,
    paths: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const p of paths) {
        await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(p)}`)
    }
}

// Ephemeral ISOs Packer leaves in the Proxmox ISO store: its answer-file ISOs
// (`packer*.iso[.tmp]`) and SHA-hash-named download-cache copies. `preserveVirtio`
// keeps the persistent virtio-win cache (routine prune), which the `packer*`
// glob would otherwise catch by accident.
export const ephemeralPackerIsoFind = (
    isoStore: string,
    { preserveVirtio }: { preserveVirtio: boolean }
): string =>
    `find ${isoStore} -maxdepth 1 ` +
    (preserveVirtio ? `! -name ${shellQuote(VIRTIO_WIN_ISO)} ` : '') +
    `\\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`

// Build VMs are named `packer-<recipe>` (the vm_name in every recipe), so match
// by name rather than a VMID range: per-build VMIDs are slot-derived
// (build_vmid * 100 + slot), which a range match silently misses. `includeTemplates`
// controls the one behavioural split between prune and clean: routine prune
// spares `packer-*` templates (a successful build leaves one on purpose), while
// a full `clean` teardown reaps them too.
const findBuildVms = async (
    env: Env,
    { includeTemplates }: { includeTemplates: boolean }
): Promise<string[]> =>
    lines(
        await ssh(
            env.SSH_TARGET,
            includeTemplates
                ? `qm list 2>/dev/null | awk 'NR>1 && $2 ~ /^packer-/ {print $1}'`
                : `for v in $(qm list 2>/dev/null | awk 'NR>1 && $2 ~ /^packer-/ {print $1}'); do ` +
                      `qm config "$v" 2>/dev/null | grep -q '^template:' || echo "$v"; ` +
                      `done`
        )
    )

const reapBuildVms = async (
    env: Env,
    dryRun: boolean,
    { includeTemplates }: { includeTemplates: boolean }
): Promise<void> => {
    const orphans = await findBuildVms(env, { includeTemplates })
    if (orphans.length === 0) {
        log.info('build VMs: none found')
        return
    }
    const verb = dryRun ? 'would destroy' : 'destroying'
    for (const vmid of orphans) {
        log.note(`${verb} VM ${vmid}`)
        if (!dryRun) {
            await ssh(env.SSH_TARGET, destroyVmCommand(Number(vmid)))
        }
    }
    log.ok(
        `build VMs ${dim('·')} ${dryRun ? 'would destroy' : 'destroyed'} ${orphans.length}`
    )
}

// Disk volumes in the build storage pool whose owning VMID has no VM config —
// leaked when a VM was removed but its disk was not (a dirty teardown, or a
// `qm destroy` that failed after unlinking the config). `qm destroy
// --destroy-unreferenced-disks` never reaches these because the VM it would run
// against is already gone. Emits the volid of every such orphan. Scoped to the
// cofoundry storage pool (CF_STORAGE) so unrelated VMs' disks are never touched.
export const orphanDiskFind = (storage: string): string =>
    `pvesm list ${shellQuote(storage)} --content images 2>/dev/null | ` +
    `awk 'NR>1 {print $NF"\\t"$1}' | ` +
    `while IFS=$'\\t' read -r vmid volid; do ` +
    `qm config "$vmid" >/dev/null 2>&1 || echo "$volid"; ` +
    `done`

const freeVolumes = async (
    env: Env,
    volids: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const v of volids) {
        await ssh(
            env.SSH_TARGET,
            `pvesm free ${shellQuote(v)} 2>/dev/null || true`
        )
    }
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
            ephemeralPackerIsoFind(paths.isoStore, { preserveVirtio: false })
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

    // Match every VMID, not the legacy 91xx/92xx range: modern builds use
    // slot-derived VMIDs (build_vmid * 100 + slot), whose multi-GB dumps the old
    // globs missed entirely. Clean is a full wipe, so no age gate.
    log.step(`removing stale dump files from ${paths.dump}`)
    const dumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name 'vzdump-qemu-*' 2>/dev/null || true`
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

    // Half-swapped work symlinks (`cofoundry-work.new.<pid>`) are siblings of
    // `cofoundry-work`, so the directory wipe above never touches them. A dirty
    // teardown mid-`mv` leaves one behind.
    log.step('removing orphaned work links')
    const workLinks = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name ${shellQuote(`${paths.work.split('/').pop()}.new.*`)} 2>/dev/null || true`
        )
    )
    await removeDirs(env, workLinks, false)
    report('orphaned work links', workLinks, false)

    // Destroy every `packer-*` build VM, templates included: `clean` is a full
    // teardown, so a leftover build template is a leftover like any other. Their
    // disks live in the VM storage pool (not $PVE_DUMP_DIR) and go with them.
    log.step('build VMs (packer-*, including templates)')
    await reapBuildVms(env, false, { includeTemplates: true })

    // Sweep disks orphaned in the storage pool — those whose owning VM is already
    // gone, which the VM reap above (and its --destroy-unreferenced-disks) can
    // never reach. Runs after the reap so freshly-purged disks are already gone.
    log.step(`orphaned disks in ${env.CF_STORAGE} (no owning VM)`)
    const orphanDisks = lines(
        await ssh(env.SSH_TARGET, orphanDiskFind(env.CF_STORAGE))
    )
    await freeVolumes(env, orphanDisks, false)
    report('orphaned disks', orphanDisks, false)

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
    // The persistent virtio-win cache shares the `packer-` prefix, so preserve
    // it here — re-downloading ~700MB on the next Windows build is not cleanup.
    log.step('ephemeral Packer ISOs in Proxmox ISO storage')
    const packerIsos = lines(
        await ssh(
            env.SSH_TARGET,
            ephemeralPackerIsoFind(paths.isoStore, { preserveVirtio: true })
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
    await reapBuildVms(env, dryRun, { includeTemplates: false })

    // 5. Orphaned per-build repo scratch in cofoundry-tmp: writable repo copies
    // (`build-*`), upload tarballs (`repo-*.tar.gz`), and download staging
    // (`sync-*`). Each build removes its own in a finally/SIGINT handler, but a
    // dirty teardown (SIGKILL/OOM/host reboot) leaks it. Age-gated so a
    // concurrent build's active scratch (fresh mtime) is never swept.
    log.step(`stale build scratch in ${paths.tmp} older than ${days} day(s)`)
    const staleScratch = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.tmp)} -mindepth 1 -maxdepth 1 \\( -name 'build-*' -o -name 'repo-*.tar.gz' -o -name 'sync-*' \\) -mtime +${days} 2>/dev/null || true`
        )
    )
    await removeDirs(env, staleScratch, dryRun)
    report('stale build scratch', staleScratch, dryRun)

    // 6. Content-addressed repository snapshots older than --days. Keep the
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

    // 7. Half-swapped work links (`cofoundry-work.new.<pid>`) orphaned when a
    // dirty teardown interrupts the snapshot install's atomic `mv`. They sit
    // beside the work dir, so the step below (which only touches work itself)
    // never reaps them.
    log.step('orphaned work links')
    const workLinks = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name ${shellQuote(`${paths.work.split('/').pop()}.new.*`)} 2>/dev/null || true`
        )
    )
    await removeDirs(env, workLinks, dryRun)
    report('orphaned work links', workLinks, dryRun)

    // 8. Current working link (only if no other process is using its target).
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
