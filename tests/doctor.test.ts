import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
    apiCheck,
    apiCheckScript,
    bridgeCheck,
    buildBridgeCheck,
    diskSpaceCheck,
    dnsmasqCheck,
    doctorSweepScript,
    ISO_MASTERING_TOOLS,
    NODE_TOOLS,
    parseDfAvailKib,
    parsePvesmStatus,
    parseToolSweep,
    r2Check,
    runDoctorChecks,
    splitSections,
    storageCheck,
    toolsCheck,
    type DoctorCheck,
    type DoctorDeps,
} from '@/doctor.ts'
import { doctorReportJson, runDoctorCommand } from '@/commands/doctor.ts'

const PROC_ENV: NodeJS.ProcessEnv = {
    PVE_HOST: '192.0.2.10',
    PVE_NODE: 'pve-node01',
    PVE_TOKEN_ID: 'root@pam!cofoundry',
    PVE_TOKEN_SECRET: 'cf-doctor-test-secret',
    SSH_TARGET: 'root@192.0.2.10',
}

const SWEEP_OK = [
    '### cf-doctor:tools',
    ...NODE_TOOLS.map(tool => `${tool.bin}=ok`),
    'xorriso=ok',
    'mkisofs=missing',
    '### cf-doctor:pvesm',
    'Name             Type     Status           Total            Used       Available        %',
    'local             dir     active        98559220        12345678        81234567   12.53%',
    'local-zfs     zfspool     active       228033319        10000000       218033319    4.39%',
    '### cf-doctor:link:bridge',
    '2: vmbr0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT',
    '### cf-doctor:link:build-bridge',
    '7: vmbr1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT',
    '### cf-doctor:ifquery:build-bridge',
    '',
    '### cf-doctor:addr:build-bridge',
    '7: vmbr1    inet 10.0.0.1/24 scope global vmbr1\\       valid_lft forever preferred_lft forever',
    '### cf-doctor:dnsmasq',
    'active',
    '### cf-doctor:dnsmasq-hostsdir',
    'present',
    '### cf-doctor:df:iso',
    '/dev/mapper/pve-root  98559220 12345678  81234567      14% /',
    '### cf-doctor:df:dump',
    '/dev/mapper/pve-root  98559220 12345678  81234567      14% /',
].join('\n')

const API_OK = '{"data":{"version":"8.2.4","release":"8.2"}}\n200'

const depsFor = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
    whichLocal: () => '/usr/bin/ssh',
    probeSsh: async () => {},
    captureScript: async (_target, script) =>
        script.includes('api2/json/version') ? API_OK : SWEEP_OK,
    probeR2: async () => {},
    ...overrides,
})

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
    const check = checks.find(candidate => candidate.id === id)
    if (!check) throw new Error(`no check with id ${id}`)
    return check
}

describe('runDoctorChecks', () => {
    test('missing env vars fail by name and skip every remote check', async () => {
        const report = await runDoctorChecks({}, depsFor())
        const env = byId(report.checks, 'env')
        expect(env.status).toBe('fail')
        for (const key of [
            'PVE_HOST',
            'PVE_NODE',
            'PVE_TOKEN_ID',
            'PVE_TOKEN_SECRET',
            'SSH_TARGET',
        ]) {
            expect(env.detail).toContain(key)
        }
        expect(byId(report.checks, 'ssh-connect').status).toBe('skip')
        expect(byId(report.checks, 'pve-api').status).toBe('skip')
        expect(report.ok).toBeFalse()
    })

    test('missing local ssh binary fails with a hint and skips remote checks', async () => {
        const report = await runDoctorChecks(
            PROC_ENV,
            depsFor({ whichLocal: () => null })
        )
        const local = byId(report.checks, 'local-ssh')
        expect(local.status).toBe('fail')
        expect(local.hint).toContain('OpenSSH')
        expect(byId(report.checks, 'node-tools').status).toBe('skip')
        expect(report.ok).toBeFalse()
    })

    test('an unreachable node fails ssh-connect and skips the node checks', async () => {
        const report = await runDoctorChecks(
            PROC_ENV,
            depsFor({
                probeSsh: async () => {
                    throw new Error('Connection timed out')
                },
            })
        )
        const connect = byId(report.checks, 'ssh-connect')
        expect(connect.status).toBe('fail')
        expect(connect.detail).toContain('Connection timed out')
        expect(connect.hint).toContain('authorized_keys')
        expect(byId(report.checks, 'storage').status).toBe('skip')
        expect(byId(report.checks, 'pve-api').status).toBe('skip')
        expect(report.ok).toBeFalse()
    })

    test('a healthy node with zfspool disk storage passes with a warning', async () => {
        const report = await runDoctorChecks(
            { ...PROC_ENV, CF_STORAGE: 'local-zfs' },
            depsFor()
        )
        expect(byId(report.checks, 'env').status).toBe('ok')
        expect(byId(report.checks, 'ssh-connect').status).toBe('ok')
        expect(byId(report.checks, 'node-tools').status).toBe('ok')
        const storage = byId(report.checks, 'storage')
        expect(storage.status).toBe('warn')
        expect(storage.detail).toContain('zfspool')
        expect(byId(report.checks, 'iso-storage').status).toBe('ok')
        expect(byId(report.checks, 'bridge').status).toBe('ok')
        const buildBridge = byId(report.checks, 'build-bridge')
        expect(buildBridge.status).toBe('ok')
        expect(buildBridge.detail).toContain('10.0.0.1')
        expect(buildBridge.detail).toContain('10.0.0.0/24')
        const api = byId(report.checks, 'pve-api')
        expect(api.status).toBe('ok')
        expect(api.detail).toContain('8.2.4')
        expect(byId(report.checks, 'dnsmasq').status).toBe('ok')
        expect(byId(report.checks, 'iso-space').status).toBe('ok')
        expect(byId(report.checks, 'dump-space').status).toBe('ok')
        // R2 is unset in PROC_ENV: optional config skips, never fails.
        expect(byId(report.checks, 'r2').status).toBe('skip')
        // Warnings alone must not flip the exit-relevant flag.
        expect(report.ok).toBeTrue()
    })

    test('a rejected token fails the report even when all else is healthy', async () => {
        const report = await runDoctorChecks(
            PROC_ENV,
            depsFor({
                captureScript: async (_target, script) =>
                    script.includes('api2/json/version')
                        ? '{"data":null}\n401'
                        : SWEEP_OK,
            })
        )
        const api = byId(report.checks, 'pve-api')
        expect(api.status).toBe('fail')
        expect(api.hint).toContain('PVE_TOKEN_ID')
        expect(report.ok).toBeFalse()
    })
})

describe('doctorSweepScript', () => {
    test('is valid Bash and probes the configured targets', () => {
        const script = doctorSweepScript({
            bridge: 'vmbr0',
            buildBridge: 'vmbr1',
            isoCacheDir: '/var/lib/vz/template/iso',
            dumpDir: '/var/lib/vz/dump',
        })
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain("'vmbr0'")
        expect(script).toContain("'vmbr1'")
        expect(script).toContain("df -Pk '/var/lib/vz/template/iso'")
        expect(script).toContain("df -Pk '/var/lib/vz/dump'")
        for (const tool of NODE_TOOLS) expect(script).toContain(tool.bin)
    })
})

describe('splitSections', () => {
    test('splits marker-delimited output and trims each section', () => {
        const sections = splitSections(
            'preamble\n### cf-doctor:a\nline1\nline2\n### cf-doctor:b\n\nonly\n'
        )
        expect(sections.get('a')).toBe('line1\nline2')
        expect(sections.get('b')).toBe('only')
    })
})

describe('toolsCheck', () => {
    test('a missing required tool fails and names it with its purpose', () => {
        const check = toolsCheck(parseToolSweep('qm=ok\npython3=missing'))
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('python3')
        expect(check.hint).toContain('python3 — ')
    })

    test('missing every ISO mastering tool is only a warning', () => {
        const check = toolsCheck(
            parseToolSweep(
                ISO_MASTERING_TOOLS.map(t => `${t}=missing`).join('\n')
            )
        )
        expect(check.status).toBe('warn')
        expect(check.detail).toContain('windows-')
    })

    test('all tools present is ok', () => {
        const check = toolsCheck(new Set())
        expect(check.status).toBe('ok')
    })
})

describe('parsePvesmStatus / storageCheck', () => {
    const POOLS = parsePvesmStatus(
        [
            'Name             Type     Status           Total            Used       Available        %',
            'local             dir     active        98559220        12345678        81234567   12.53%',
            'local-zfs     zfspool     active       228033319        10000000       218033319    4.39%',
            'tight             dir     active        10485760         9437184         1048576   90.00%',
            'broken            dir   disabled               0               0               0    0.00%',
        ].join('\n')
    )

    test('parses names, types, statuses and available KiB', () => {
        expect(POOLS).toHaveLength(4)
        expect(POOLS[0]).toEqual({
            name: 'local',
            type: 'dir',
            status: 'active',
            availKib: 81234567,
        })
    })

    test('an unknown pool fails and lists the pools that exist', () => {
        const check = storageCheck(POOLS, 'nope', 'disks')
        expect(check.status).toBe('fail')
        expect(check.hint).toContain('local')
        expect(check.hint).toContain('CF_STORAGE')
    })

    test('an inactive pool fails', () => {
        const check = storageCheck(POOLS, 'broken', 'disks')
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('disabled')
    })

    test('a zfspool disk pool warns about host-side shrink', () => {
        const check = storageCheck(POOLS, 'local-zfs', 'disks')
        expect(check.status).toBe('warn')
        expect(check.detail).toContain('shrink')
        expect(check.detail).toContain('zfspool')
    })

    test('low free space warns with a prune hint', () => {
        const check = storageCheck(POOLS, 'tight', 'isos')
        expect(check.status).toBe('warn')
        expect(check.detail).toContain('1.0 GiB')
        expect(check.hint).toContain('cf prune')
    })

    test('an active file-backed pool with space is ok', () => {
        const check = storageCheck(POOLS, 'local', 'disks')
        expect(check.status).toBe('ok')
        expect(check.detail).toContain('dir')
        expect(check.detail).toContain('77.5 GiB')
    })
})

describe('bridge checks', () => {
    test('a present CF_BRIDGE is ok, an absent one fails', () => {
        expect(bridgeCheck('2: vmbr0: <UP> ...', 'vmbr0').status).toBe('ok')
        const check = bridgeCheck('', 'vmbr9')
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('vmbr9')
    })

    test('a build bridge with a /24 address reports its subnet', () => {
        const check = buildBridgeCheck(
            '2: vmbr1: <UP> ...',
            '',
            '7: vmbr1    inet 10.0.0.1/24 scope global vmbr1',
            'vmbr1'
        )
        expect(check.status).toBe('ok')
        expect(check.detail).toContain('10.0.0.0/24')
    })

    test('a build bridge without an address fails toward cf bootstrap', () => {
        const check = buildBridgeCheck('2: vmbr1: <UP> ...', '', '', 'vmbr1')
        expect(check.status).toBe('fail')
        expect(check.hint).toContain('cf bootstrap')
    })

    test('an absent build bridge fails toward cf bootstrap', () => {
        const check = buildBridgeCheck('', '', '', 'vmbr1')
        expect(check.status).toBe('fail')
        expect(check.hint).toContain('cf bootstrap')
    })
})

describe('disk space checks', () => {
    test('parses the POSIX df available column', () => {
        expect(
            parseDfAvailKib('/dev/sda1  98559220 12345678  81234567  14% /')
        ).toBe(81234567)
        expect(parseDfAvailKib('')).toBeUndefined()
    })

    test('a missing directory fails with its own hint, low space warns, plenty is ok', () => {
        const base = { id: 'iso-space', name: 'ISO cache space' }
        const missing = diskSpaceCheck('', base, '/x', 'check CF_ISO_STORAGE')
        expect(missing.status).toBe('fail')
        // The hint is per-directory: the ISO dir must not blame PVE_DUMP_DIR.
        expect(missing.hint).toBe('check CF_ISO_STORAGE')
        const low = diskSpaceCheck(
            '/dev/sda1 10485760 9437184 1048576 90% /',
            base,
            '/x',
            'check CF_ISO_STORAGE'
        )
        expect(low.status).toBe('warn')
        expect(low.hint).toContain('cf prune')
        expect(
            diskSpaceCheck(
                '/dev/sda1 98559220 12345678 81234567 14% /',
                base,
                '/x',
                'check CF_ISO_STORAGE'
            ).status
        ).toBe('ok')
    })
})

describe('dnsmasqCheck', () => {
    test('active service with the hostsfile dir is ok', () => {
        expect(dnsmasqCheck('active', 'present').status).toBe('ok')
    })

    test('an inactive or absent service fails toward cf bootstrap', () => {
        const inactive = dnsmasqCheck('inactive', 'present')
        expect(inactive.status).toBe('fail')
        expect(inactive.detail).toContain('inactive')
        expect(inactive.hint).toContain('cf bootstrap')
        expect(dnsmasqCheck('', 'present').detail).toContain('not found')
        expect(dnsmasqCheck('unknown', 'present').detail).toContain('not found')
    })

    test('a missing hostsfile directory fails even when the service runs', () => {
        const check = dnsmasqCheck('active', '')
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('cofoundry-hosts.d')
        expect(check.hint).toContain('cf bootstrap')
    })
})

describe('r2Check', () => {
    const R2_ENV = {
        R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
        R2_BUCKET: 'cofoundry-templates',
    }

    test('unconfigured R2 skips instead of failing', async () => {
        const check = await r2Check({}, depsFor())
        expect(check.status).toBe('skip')
        expect(check.detail).toContain('cf upload --r2')
    })

    test('a partial R2 config fails', async () => {
        const check = await r2Check(
            { R2_ENDPOINT: R2_ENV.R2_ENDPOINT },
            depsFor()
        )
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('incomplete')
    })

    test('a missing aws CLI fails with an install hint', async () => {
        const check = await r2Check(
            R2_ENV,
            depsFor({
                whichLocal: bin => (bin === 'aws' ? null : '/usr/bin/ssh'),
            })
        )
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('aws')
    })

    test('head-bucket success is ok; failure carries the first error line', async () => {
        const ok = await r2Check(R2_ENV, depsFor())
        expect(ok.status).toBe('ok')
        expect(ok.detail).toContain('cofoundry-templates')
        const failed = await r2Check(
            R2_ENV,
            depsFor({
                probeR2: async () => {
                    throw new Error('403 Forbidden\nlong aws traceback')
                },
            })
        )
        expect(failed.status).toBe('fail')
        expect(failed.detail).toBe('403 Forbidden')
    })
})

describe('runDoctorCommand exit mapping', () => {
    /** Run the command with stdout captured; the collected lines survive a
     *  rejection so the --json output can be asserted alongside the error. */
    const captureRun = async (
        run: () => Promise<void>
    ): Promise<{ lines: string[]; error: unknown }> => {
        const saved = console.log
        const lines: string[] = []
        let error: unknown
        console.log = (line: unknown) => void lines.push(String(line))
        try {
            await run()
        } catch (err) {
            error = err
        } finally {
            console.log = saved
        }
        return { lines, error }
    }

    test('a failing report rejects (main maps it to exit 1) and --json still prints', async () => {
        const { lines, error } = await captureRun(() =>
            runDoctorCommand(
                { json: true },
                depsFor({ whichLocal: () => null })
            )
        )
        expect(String(error)).toMatch(/check\(s\) failed/)
        const parsed = JSON.parse(lines.join('\n')) as { ok: boolean }
        expect(parsed.ok).toBeFalse()
    })

    test('an all-ok report resolves without throwing', async () => {
        const previous = new Map<string, string | undefined>()
        for (const [key, value] of Object.entries(PROC_ENV)) {
            previous.set(key, process.env[key])
            process.env[key] = value
        }
        try {
            const { lines, error } = await captureRun(() =>
                runDoctorCommand({ json: true }, depsFor())
            )
            expect(error).toBeUndefined()
            const parsed = JSON.parse(lines.join('\n')) as { ok: boolean }
            expect(parsed.ok).toBeTrue()
        } finally {
            for (const [key, value] of previous) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
            }
        }
    })
})

describe('apiCheckScript / apiCheck', () => {
    const ENV = {
        PVE_HOST: '192.0.2.10',
        PVE_PORT: 8006,
        PVE_TOKEN_ID: 'root@pam!cofoundry',
        PVE_TOKEN_SECRET: 'cf-doctor-test-secret',
    }

    test('script is valid Bash and carries the token in a heredoc, not argv', () => {
        const script = apiCheckScript(ENV)
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain("'https://192.0.2.10:8006/api2/json/version'")
        // The Authorization header must be heredoc-fed via -H @-, never a -H
        // 'Authorization: ...' argument that would land in the process list.
        expect(script).toContain('-H @-')
        const curlLine = script.split('\n')[0]!
        expect(curlLine).not.toContain('cf-doctor-test-secret')
    })

    test('200 with a version body is ok', () => {
        const check = apiCheck(API_OK)
        expect(check.status).toBe('ok')
        expect(check.detail).toContain('8.2.4')
    })

    test('401 fails with a token hint', () => {
        const check = apiCheck('{"data":null}\n401')
        expect(check.status).toBe('fail')
        expect(check.detail).toContain('401')
        expect(check.hint).toContain('PVE_TOKEN_SECRET')
    })

    test('garbage output fails without throwing', () => {
        expect(apiCheck('').status).toBe('fail')
        expect(apiCheck('curl: weird').status).toBe('fail')
    })
})

describe('doctorReportJson', () => {
    test('emits parseable JSON with the check fields and the ok flag', async () => {
        const report = await runDoctorChecks(PROC_ENV, depsFor())
        const parsed = JSON.parse(doctorReportJson(report)) as {
            ok: boolean
            checks: DoctorCheck[]
        }
        expect(parsed.ok).toBeTrue()
        expect(parsed.checks.length).toBe(report.checks.length)
        const api = parsed.checks.find(check => check.id === 'pve-api')!
        expect(api.name).toBe('Proxmox API')
        expect(api.status).toBe('ok')
        expect(typeof api.detail).toBe('string')
    })
})
