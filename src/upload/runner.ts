import { createRenderer, title, accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import { buildRemoteOutDir } from '@/build/paths.ts'
import { log } from '@/log.ts'
import type { UploadOptions } from '@/upload/model.ts'
import { loadSidecars } from '@/upload/sidecars.ts'
import {
    executeUpload,
    localUploadSource,
    remoteUploadSource,
} from '@/upload/source.ts'
import {
    formatArtifactSize,
    renderUploadTemplate,
    uploadVariables,
} from '@/upload/template.ts'

export const runUpload = async (
    env: Env,
    opts: UploadOptions
): Promise<void> => {
    if (!env.CF_UPLOAD_CMD) throw new Error('CF_UPLOAD_CMD is not set')
    const sidecarCommand = env.CF_SIDECAR_UPLOAD_CMD
    const source = opts.remote
        ? remoteUploadSource(
              env.SSH_TARGET,
              opts.sourceDir ?? buildRemoteOutDir(env)
          )
        : localUploadSource(opts.sourceDir ?? env.CF_OUT_DIR)
    const items = await loadSidecars(source, opts.names)
    if (items.length === 0) {
        log.warn(`No sidecar .json files found in ${source.label}`)
        return
    }

    const renderer = createRenderer({
        title: title(
            `Uploading ${items.length} artifact${items.length === 1 ? '' : 's'} ${dim('from')} ${accent(source.label)}${opts.dryRun ? dim(' (dry-run)') : ''}`
        ),
        outputLines: 2,
    })
    const failed: string[] = []
    let succeeded = 0

    try {
        for (const { sidecar } of items) {
            const task = renderer.task(sidecar.name)
            const artifactFile = `${sidecar.name}.vma.zst`
            const sidecarFile = `${sidecar.name}.json`
            task.setPhase('checking artifact')
            if (!(await source.fileExists(artifactFile))) {
                task.fail(`artifact missing (${source.pathOf(artifactFile)})`)
                failed.push(sidecar.name)
                continue
            }

            const variables = uploadVariables(
                sidecar,
                source.pathOf(artifactFile)
            )
            const artifactCommand = renderUploadTemplate(
                env.CF_UPLOAD_CMD,
                variables
            )
            task.setPhase(
                `uploading artifact ${dim(`(${formatArtifactSize(sidecar.size)})`)}`
            )
            try {
                if (opts.dryRun) task.log(artifactCommand)
                else await executeUpload(source, artifactCommand, task)

                if (sidecarCommand && !opts.skipSidecar) {
                    const command = renderUploadTemplate(sidecarCommand, {
                        ...variables,
                        file: source.pathOf(sidecarFile),
                        filename: `${sidecar.name}-${sidecar.sha256}.json`,
                    })
                    task.setPhase('uploading sidecar')
                    if (opts.dryRun) task.log(command)
                    else await executeUpload(source, command, task)
                }
                task.succeed(opts.dryRun ? 'planned' : 'uploaded')
                succeeded++
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                task.fail(message)
                failed.push(sidecar.name)
            }
        }
    } finally {
        renderer.finish()
    }

    log.blank()
    if (failed.length > 0)
        throw new Error(
            `${failed.length} upload(s) failed: ${failed.join(', ')}`
        )
    log.ok(`Uploaded ${succeeded}/${items.length}.`)
}
