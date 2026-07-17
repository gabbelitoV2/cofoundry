import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInit } from '../src/config-init.ts'

const KEYS = [
    'PVE_HOST',
    'PVE_DUMP_DIR',
    'R2_PREFIX',
    'CF_BUILD_ATTEMPTS',
    'CF_UPLOAD_CONCURRENCY',
    'CF_DOWNLOAD_CONCURRENCY',
    'CF_OUT_DIR',
] as const

let dir: string
const saved: Partial<Record<(typeof KEYS)[number], string>> = {}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-init-'))
    for (const key of KEYS) {
        saved[key] = process.env[key]
        delete process.env[key]
    }
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of KEYS) {
        const value = saved[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

describe('runInit', () => {
    test('--from-env preserves every migrated non-secret setting', () => {
        process.env.PVE_HOST = 'private.example.com'
        process.env.PVE_DUMP_DIR = '/mnt/dump'
        process.env.R2_PREFIX = 'artifacts/'
        process.env.CF_BUILD_ATTEMPTS = '5'
        process.env.CF_UPLOAD_CONCURRENCY = '4'
        process.env.CF_DOWNLOAD_CONCURRENCY = '6'
        process.env.CF_OUT_DIR = './output'

        runInit({ fromEnv: true }, dir)
        const config = readFileSync(join(dir, 'cofoundry.toml'), 'utf8')

        expect(config).toContain('host     = "${PVE_HOST}"')
        expect(config).not.toContain('private.example.com')
        expect(config).toContain('dump_dir = "/mnt/dump"')
        expect(config).toContain('prefix     = "artifacts/"')
        expect(config).toContain('attempts = 5')
        expect(config).toContain('upload_concurrency   = 4')
        expect(config).toContain('download_concurrency = 6')
        expect(config).toContain('out_dir = "./output"')
    })
})
