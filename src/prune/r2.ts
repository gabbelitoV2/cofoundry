import { execa } from 'execa'
import { accent, dim } from '@cofoundry/ui'
import { log } from '@/log.ts'

export type PruneR2Options = {
    keep: number
    dryRun: boolean
}

export type R2Location = {
    endpoint: string
    bucket: string
    prefix: string
}

export type R2Object = {
    Key: string
    LastModified: string
    Size: number
}

export type R2PruneGroup = {
    prefix: string
    artifacts: number
    stale: R2Object[]
}

export type R2PrunePlan = {
    groups: R2PruneGroup[]
    orphanSidecars: string[]
    deletions: string[]
}

export const planR2Prune = (objects: R2Object[], keep: number): R2PrunePlan => {
    if (!Number.isInteger(keep) || keep < 0)
        throw new Error('--keep must be a non-negative integer')

    const artifactGroups = new Map<string, R2Object[]>()
    const sidecarKeys = new Set<string>()
    for (const object of objects) {
        if (object.Key.endsWith('.vma.zst')) {
            const match = object.Key.match(/^(.+)\/[^/]+\.vma\.zst$/)
            if (!match) continue
            const prefix = match[1]!
            const group = artifactGroups.get(prefix) ?? []
            group.push(object)
            artifactGroups.set(prefix, group)
        } else if (object.Key.endsWith('.json')) {
            sidecarKeys.add(object.Key)
        }
    }

    const deletions: string[] = []
    const liveArtifacts = new Set<string>()
    const groups: R2PruneGroup[] = []
    for (const [prefix, artifacts] of artifactGroups) {
        artifacts.sort((a, b) => b.LastModified.localeCompare(a.LastModified))
        const live = artifacts.slice(0, keep)
        const stale = artifacts.slice(keep)
        for (const artifact of live) liveArtifacts.add(artifact.Key)
        for (const artifact of stale) {
            deletions.push(artifact.Key)
            const sidecar = artifact.Key.replace(/\.vma\.zst$/, '.json')
            if (sidecarKeys.has(sidecar)) deletions.push(sidecar)
        }
        groups.push({ prefix, artifacts: artifacts.length, stale })
    }

    const queued = new Set(deletions)
    const orphanSidecars = [...sidecarKeys].filter(key => {
        const artifact = key.replace(/\.json$/, '.vma.zst')
        return !liveArtifacts.has(artifact) && !queued.has(key)
    })
    deletions.push(...orphanSidecars)
    return { groups, orphanSidecars, deletions }
}

const awsS3 = async (endpoint: string, args: string[]): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3api', ...args],
        { stdin: 'inherit', stderr: 'inherit' }
    )
    return stdout
}

export const runPruneR2 = async (
    { endpoint, bucket, prefix }: R2Location,
    { keep, dryRun }: PruneR2Options
): Promise<void> => {
    log.section(`R2 prune ${dim('·')} ${accent(`s3://${bucket}/${prefix}`)}`)
    if (dryRun) log.warn('dry-run: no objects will be deleted')
    log.step('listing objects')
    const raw = await awsS3(endpoint, [
        'list-objects-v2',
        '--bucket',
        bucket,
        '--prefix',
        prefix,
    ])
    const parsed = raw.trim() ? JSON.parse(raw) : { Contents: [] }
    const plan = planR2Prune(parsed.Contents ?? [], keep)

    for (const group of plan.groups) {
        if (group.stale.length === 0) {
            log.info(
                `${accent(group.prefix)} ${dim('·')} ${group.artifacts} artifact(s), within keep=${keep}`
            )
            continue
        }
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(
            `${accent(group.prefix)} ${dim('·')} ${group.artifacts} artifact(s), ${verb} ${group.stale.length}`
        )
        for (const artifact of group.stale) {
            log.note(`${artifact.Key}  (${artifact.LastModified})`)
            const sidecar = artifact.Key.replace(/\.vma\.zst$/, '.json')
            if (plan.deletions.includes(sidecar))
                log.note(`${sidecar}  (paired sidecar)`)
        }
    }
    if (plan.orphanSidecars.length > 0) {
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(
            `orphan sidecars ${dim('·')} ${verb} ${plan.orphanSidecars.length}`
        )
        for (const key of plan.orphanSidecars) log.note(key)
    }

    if (!dryRun) {
        for (const key of plan.deletions) {
            await awsS3(endpoint, [
                'delete-object',
                '--bucket',
                bucket,
                '--key',
                key,
            ])
        }
    }
    log.blank()
    log.ok(
        dryRun
            ? `Dry-run: ${plan.deletions.length} object(s) would be deleted across ${plan.groups.length} template(s).`
            : `Deleted ${plan.deletions.length} object(s) across ${plan.groups.length} template(s).`
    )
}
