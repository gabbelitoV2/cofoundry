import { execa } from 'execa'
import type { Env } from './env.ts'
import { log } from './log.ts'
import { shellQuote } from './util.ts'

const REMOTE_WORK_DIR = '/tmp/cofoundry'
const ISO_STORE_DIR = '/var/lib/vz/template/iso'
const ISO_CACHE_DIR = '/var/lib/cofoundry/iso-cache'
const DUMP_DIR = '/var/lib/vz/dump'

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
        `du -sh ${REMOTE_WORK_DIR} 2>/dev/null | cut -f1 || echo "(not present)"`
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)

    log.step(`removing uploaded ISOs from ${ISO_STORE_DIR}`)
    const isos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 \\( -name 'packer*.iso' -o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso' \\) 2>/dev/null || true`
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

    // 1. Ephemeral Packer ISOs (any age).
    log.step('ephemeral Packer ISOs in Proxmox ISO storage')
    const packerIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_STORE_DIR} -maxdepth 1 -name 'packer*.iso' 2>/dev/null || true`
        )
    )
    await remove(env, packerIsos, dryRun)
    report('ephemeral Packer ISOs', packerIsos, dryRun)

    // 2. iso-cache files older than --days.
    log.step(`iso-cache files older than ${days} day(s)`)
    const oldIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${ISO_CACHE_DIR} -maxdepth 1 -name '*.iso' -mtime +${days} 2>/dev/null || true`
        )
    )
    await remove(env, oldIsos, dryRun)
    report('stale iso-cache entries', oldIsos, dryRun)

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
            const sz = await ssh(
                env.SSH_TARGET,
                `du -sh ${REMOTE_WORK_DIR} 2>/dev/null | cut -f1 || echo "(absent)"`
            )
            log.info(`${REMOTE_WORK_DIR}: would remove (${sz})`)
        } else {
            await ssh(env.SSH_TARGET, `rm -rf ${REMOTE_WORK_DIR}`)
            log.ok(`removed ${REMOTE_WORK_DIR}`)
        }
    }

    log.ok(dryRun ? 'prune dry-run done' : 'prune done')
}
