import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '../src/env.ts'

const REQUIRED: Record<string, string> = {
    PVE_HOST: 'pve.example.com',
    PVE_NODE: 'pve1',
    PVE_TOKEN_ID: 'root@pam!builder',
    PVE_TOKEN_SECRET: 'sekret',
    SSH_TARGET: 'root@pve.example.com',
}

const VARS_TO_RESET = [
    ...Object.keys(REQUIRED),
    'PVE_PORT',
    'PVE_DUMP_DIR',
    'CF_OUT_DIR',
    'CF_SKIP_ARTIFACT_SYNC',
    'CF_BRIDGE',
    'CF_BUILD_BRIDGE',
    'CF_STORAGE',
    'CF_ISO_STORAGE',
    'CF_BUILD_DNS',
    'CF_UPLOAD_CMD',
    'CF_PUBLIC_URL_TMPL',
]

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
    for (const k of VARS_TO_RESET) {
        saved[k] = process.env[k]
        delete process.env[k]
    }
    for (const [k, v] of Object.entries(REQUIRED)) {
        process.env[k] = v
    }
})

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
})

describe('loadEnv', () => {
    test('parses required vars and applies defaults', () => {
        const env = loadEnv()
        expect(env.PVE_HOST).toBe('pve.example.com')
        expect(env.PVE_PORT).toBe(8006)
        expect(env.PVE_DUMP_DIR).toBe('/var/lib/vz/dump')
        expect(env.CF_OUT_DIR).toBe('./dist')
        expect(env.CF_BRIDGE).toBe('vmbr0')
        expect(env.CF_BUILD_BRIDGE).toBe('vmbr1')
        expect(env.CF_STORAGE).toBe('local')
        expect(env.CF_ISO_STORAGE).toBe('local')
        expect(env.CF_BUILD_DNS).toBe('1.1.1.1')
        expect(env.CF_SKIP_ARTIFACT_SYNC).toBe(false)
    })

    test('throws when a required var is missing', () => {
        delete process.env.PVE_HOST
        expect(() => loadEnv()).toThrow()
    })

    test('coerces PVE_PORT to a number', () => {
        process.env.PVE_PORT = '8443'
        expect(loadEnv().PVE_PORT).toBe(8443)
    })

    test.each([
        ['1', true],
        ['true', true],
        ['0', false],
        ['false', false],
        ['anything else', false],
    ])('CF_SKIP_ARTIFACT_SYNC=%p → %p', (input, expected) => {
        process.env.CF_SKIP_ARTIFACT_SYNC = input
        expect(loadEnv().CF_SKIP_ARTIFACT_SYNC).toBe(expected)
    })
})
