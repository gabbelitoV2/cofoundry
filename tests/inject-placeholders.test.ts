import { afterEach, describe, expect, test } from 'bun:test'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
    new URL('../scripts/inject-placeholders.sh', import.meta.url)
)
const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true })
})

describe('inject-placeholders.sh', () => {
    test('protects generated Windows credentials with mode 0600', () => {
        const root = mkdtempSync(join(tmpdir(), 'cf-inject-'))
        tempDirs.push(root)
        const recipeDir = join(root, 'builds', 'windows-test')
        const runnerTemp = join(root, 'runner-temp')
        mkdirSync(recipeDir, { recursive: true })
        mkdirSync(runnerTemp)
        const answerFile = join(recipeDir, 'autounattend.xml')
        writeFileSync(
            answerFile,
            '<Password>__PACKER_ADMIN_PASSWORD__</Password>'
        )

        const result = Bun.spawnSync(['bash', script, 'windows-test'], {
            cwd: root,
            env: { ...process.env, RUNNER_TEMP: runnerTemp },
        })
        expect(result.exitCode).toBe(0)

        const varsFile = join(
            runnerTemp,
            'packer-vars-windows-test.pkrvars.hcl'
        )
        expect(statSync(varsFile).mode & 0o777).toBe(0o600)
        expect(statSync(answerFile).mode & 0o777).toBe(0o600)
        expect(readFileSync(varsFile, 'utf8')).toContain('winrm_password = ')
        expect(readFileSync(answerFile, 'utf8')).not.toContain(
            '__PACKER_ADMIN_PASSWORD__'
        )
    })
})
