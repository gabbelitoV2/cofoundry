import { execa, ExecaError } from 'execa'

export const captureRemote = async (
    target: string,
    cmd: string
): Promise<string> => {
    try {
        const { stdout } = await execa('ssh', [target, cmd], {
            stdin: 'inherit',
            stderr: 'inherit',
        })
        return stdout
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(
                `"ssh" not found — is it installed and on your PATH?`
            )
        }
        throw err
    }
}

export const remoteStreaming = (target: string, cmd: string): Promise<void> =>
    streaming('ssh', [target, cmd])

export const streaming = async (cmd: string, args: string[]): Promise<void> => {
    try {
        await execa(cmd, args, { stdio: 'inherit' })
    } catch (err) {
        if (err instanceof ExecaError && err.code === 'ENOENT') {
            throw new Error(
                `"${cmd}" not found — is it installed and on your PATH?`
            )
        }
        throw err
    }
}
