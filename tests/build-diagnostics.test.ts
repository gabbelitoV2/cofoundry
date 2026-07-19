import { describe, expect, test } from 'bun:test'
import {
    DIAG_TMPFS_BASE,
    diagnosticsRemoteDir,
} from '@/build/diagnostics/paths.ts'
import {
    buildDiagnosticsRecorder,
    recorderLifetimeSec,
    sweepStaleDiagnosticsCommand,
} from '@/build/diagnostics/recorder.ts'
import {
    debianGuestLogs,
    genericLinuxGuestLogs,
    guestLogSpecs,
    parseGuestExecOutput,
    rhelGuestLogs,
    ubuntuGuestLogs,
    windowsGuestLogs,
} from '@/build/diagnostics/guest-logs.ts'
import { addSensitiveValues } from '@/util.ts'

describe('diagnosticsRemoteDir', () => {
    test('lives on the tmpfs base, keyed by vmid', () => {
        expect(diagnosticsRemoteDir(100201)).toBe(`${DIAG_TMPFS_BASE}/100201`)
        expect(DIAG_TMPFS_BASE.startsWith('/run')).toBe(true)
    })
})

describe('buildDiagnosticsRecorder', () => {
    const script = buildDiagnosticsRecorder(100201, {
        maxLifetimeSec: 7200,
        guestLogs: ubuntuGuestLogs,
    })

    test('captures via qm monitor into the vmid tmpfs dir', () => {
        expect(script).toContain('qm monitor 100201')
        expect(script).toContain(`${DIAG_TMPFS_BASE}/100201`)
    })

    test('writes the ring buffer to tmpfs, never to VM storage', () => {
        expect(script).not.toContain('/var/lib/vz')
        expect(script).toContain("df -Pk '/run/cofoundry-diag'")
    })

    test('bounds itself: free-space guard, ring cap, lifetime, orphan check', () => {
        expect(script).toContain('_avail')
        expect(script).toContain('32768') // default minFreeKb
        expect(script).toContain('tail -n +$(( 30 + 1 ))') // default ring cap
        expect(script).toContain('7200') // maxLifetimeSec backstop
        expect(script).toContain('ps -o ppid= -p $BASHPID')
    })

    test('probes PNG with filename-first HMP syntax, falls back to gzipped PPM', () => {
        // HMP syntax is `screendump FILE [-f FORMAT]` — the flag comes AFTER the
        // path, or QEMU rejects it with "invalid char '/' in expression".
        expect(script).toContain('.probe -f png')
        expect(script).toContain('_ext="ppm.gz"')
        expect(script).toContain('gzip -f "$_raw"')
    })

    test('tears down the watchdog too, so appending it does not orphan the watchdog', () => {
        expect(script).toContain('kill "$_DIAG_PID" "${_WDOG_PID:-}"')
        expect(script).toContain('exit 143')
    })

    test('emits guest-agent log captures for the given specs', () => {
        expect(script).toContain('qm guest exec 100201 --timeout 15')
        expect(script).toContain('/var/log/cloud-init.log')
    })

    test('omits the guest-log block when disabled', () => {
        const noLogs = buildDiagnosticsRecorder(1, {
            maxLifetimeSec: 60,
            guestLogIntervalSec: 0,
            guestLogs: ubuntuGuestLogs,
        })
        expect(noLogs).not.toContain('qm guest exec')
    })
})

describe('guestLogSpecs', () => {
    test('maps each recipe group to its family log set', () => {
        expect(guestLogSpecs('windows-server')).toBe(windowsGuestLogs)
        expect(guestLogSpecs('ubuntu')).toBe(ubuntuGuestLogs)
        expect(guestLogSpecs('debian')).toBe(debianGuestLogs)
        expect(guestLogSpecs('almalinux')).toBe(rhelGuestLogs)
        expect(guestLogSpecs('rocky-linux')).toBe(rhelGuestLogs)
    })

    test('falls back to a generic Linux set for unknown/blank groups', () => {
        expect(guestLogSpecs(undefined)).toBe(genericLinuxGuestLogs)
        expect(guestLogSpecs('freebsd-42')).toBe(genericLinuxGuestLogs)
    })

    test('targets the right installer log per family', () => {
        expect(ubuntuGuestLogs.some(s => s.name === 'subiquity')).toBe(true)
        expect(
            rhelGuestLogs.some(s => s.argv.join(' ').includes('anaconda'))
        ).toBe(true)
        expect(
            debianGuestLogs.some(s =>
                s.argv.join(' ').includes('/var/log/syslog')
            )
        ).toBe(true)
        expect(windowsGuestLogs.some(s => s.name.startsWith('panther'))).toBe(
            true
        )
    })
})

describe('sweepStaleDiagnosticsCommand', () => {
    test('reaps only old dirs under the tmpfs base, never erroring', () => {
        const cmd = sweepStaleDiagnosticsCommand(360)
        expect(cmd).toContain("find '/run/cofoundry-diag'")
        expect(cmd).toContain('-mmin +360')
        expect(cmd).toContain('|| true')
    })
})

describe('parseGuestExecOutput', () => {
    test('unwraps the guest-agent JSON out-data field', () => {
        expect(
            parseGuestExecOutput(
                '{"out-data":"hello from panther\\n","exitcode":0}'
            )
        ).toBe('hello from panther')
    })

    test('keeps non-JSON agent output as raw text', () => {
        expect(parseGuestExecOutput('  guest agent not running  ')).toBe(
            'guest agent not running'
        )
    })

    test('scrubs a registered ephemeral secret out of the log', () => {
        addSensitiveValues('S3cretUnattendPw24')
        const out = parseGuestExecOutput(
            '{"out-data":"AdminPassword=S3cretUnattendPw24 set"}'
        )
        expect(out).not.toContain('S3cretUnattendPw24')
        expect(out).toContain('[REDACTED]')
    })
})

describe('recorderLifetimeSec', () => {
    test('gives Windows a longer backstop than Linux', () => {
        expect(recorderLifetimeSec(true)).toBeGreaterThan(
            recorderLifetimeSec(false)
        )
    })
})
