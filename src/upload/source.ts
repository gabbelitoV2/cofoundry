import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import pRetry from 'p-retry'
import type { TaskHandle } from '@cofoundry/ui'
import { captureRemote, remoteStreamingScript } from '@/build/remote.ts'
import { shellQuote } from '@/util.ts'
import type { UploadSource } from '@/upload/model.ts'

const AWS_VARS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_DEFAULT_REGION',
    'AWS_REQUEST_CHECKSUM_CALCULATION',
    'AWS_RESPONSE_CHECKSUM_VALIDATION',
    'R2_ENDPOINT',
    'R2_BUCKET',
] as const

export const uploadSubprocessEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    AWS_REQUEST_CHECKSUM_CALCULATION:
        process.env.AWS_REQUEST_CHECKSUM_CALCULATION ?? 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION:
        process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ?? 'when_required',
})

const remoteEnvironmentPrefix = (): string => {
    const env = uploadSubprocessEnv()
    const pairs = AWS_VARS.flatMap(key =>
        env[key] ? [`${key}=${shellQuote(env[key]!)}`] : []
    )
    return pairs.length > 0 ? `${pairs.join(' ')} ` : ''
}

export const localUploadSource = (sourceDir: string): UploadSource => ({
    label: sourceDir,
    pathOf: name => join(sourceDir, name),
    listJsons: async () =>
        (await readdir(sourceDir)).filter(
            entry => entry.endsWith('.json') && !entry.endsWith('.json.tmp')
        ),
    readJson: name => readFile(join(sourceDir, name), 'utf8'),
    fileExists: async name =>
        access(join(sourceDir, name)).then(
            () => true,
            () => false
        ),
    exec: async command => {
        await execa('bash', ['-c', command], {
            stdio: 'inherit',
            env: uploadSubprocessEnv(),
        })
    },
})

export const remoteUploadSource = (
    target: string,
    sourceDir: string
): UploadSource => ({
    label: `${target}:${sourceDir}`,
    pathOf: name => `${sourceDir}/${name}`,
    listJsons: async () => {
        const output = await captureRemote(
            target,
            `ls -1 ${shellQuote(sourceDir)} 2>/dev/null | grep -E '\\.json$' | grep -v '\\.json\\.tmp$' || true`
        )
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
    },
    readJson: name =>
        captureRemote(target, `cat ${shellQuote(`${sourceDir}/${name}`)}`),
    fileExists: async name => {
        const output = await captureRemote(
            target,
            `[ -f ${shellQuote(`${sourceDir}/${name}`)} ] && echo 1 || echo 0`
        )
        return output.trim() === '1'
    },
    exec: command =>
        remoteStreamingScript(
            target,
            `${remoteEnvironmentPrefix()}${command}\n`
        ),
})

export const executeUpload = async (
    source: UploadSource,
    command: string,
    task: TaskHandle
): Promise<void> => {
    await pRetry(() => source.exec(command), {
        retries: 2,
        minTimeout: 2000,
        factor: 2,
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
            task.log(
                `attempt ${attemptNumber} failed (${retriesLeft} left): ${error.message.split('\n')[0]}`
            )
        },
    })
}
