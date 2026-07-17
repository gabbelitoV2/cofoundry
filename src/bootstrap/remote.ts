import { execa } from 'execa'
import { shellQuote } from '@/util.ts'

export type CaptureResult = {
    ok: boolean
    stdout: string
    stderr: string
}

export const sshOk = async (
    target: string,
    command: string
): Promise<boolean> => {
    const result = await execa('ssh', [target, command], {
        reject: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
    })
    return result.exitCode === 0
}

export const sshCapture = async (
    target: string,
    command: string
): Promise<CaptureResult> => {
    const result = await execa('ssh', [target, command], {
        reject: false,
        stdin: 'ignore',
        stderr: 'pipe',
    })
    return {
        ok: result.exitCode === 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    }
}

export const writeRemoteFile = async (
    target: string,
    path: string,
    contents: string
): Promise<void> => {
    await execa('ssh', [target, `cat > ${shellQuote(path)}`], {
        input: contents,
        stderr: 'inherit',
    })
}
