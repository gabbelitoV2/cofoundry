import { describe, expect, test } from 'bun:test'
import {
    buildDiagnosticsRecorder,
    diagnosticsRemoteDir,
    guestLogSpecs,
    linuxGuestLogs,
    recorderLifetimeSec,
    sweepStaleDiagnosticsCommand,
    windowsGuestLogs,
    DIAG_TMPFS_BASE,
} from '@/build/diagnostics.ts'

describe('diagnosticsRemoteDir', () => {
    test('lives on the tmpfs base, keyed by vmid', () => {
        expect(diagnosticsRemoteDir(100201)).toBe(`${DIAG_TMPFS_BASE}/100201`)
        expect(DIAG_TMPFS_BASE.startsWith('/run')).toBe(true)
    })
})

describe('buildDiagnosticsRecorder', () => {
    const script = buildDiagnosticsRecorder(100201, {
        maxLifetimeSec: 7200,
        guestLogs: linuxGuestLogs,
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

    test('probes PNG and falls back to PPM', () => {
        expect(script).toContain('screendump -f png')
        expect(script).toContain('_ext="ppm"')
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
            guestLogs: linuxGuestLogs,
        })
        expect(noLogs).not.toContain('qm guest exec')
    })
})

describe('guestLogSpecs', () => {
    test('selects Panther for Windows and cloud-init for Linux', () => {
        expect(guestLogSpecs(true)).toBe(windowsGuestLogs)
        expect(guestLogSpecs(false)).toBe(linuxGuestLogs)
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

describe('recorderLifetimeSec', () => {
    test('gives Windows a longer backstop than Linux', () => {
        expect(recorderLifetimeSec(true)).toBeGreaterThan(
            recorderLifetimeSec(false)
        )
    })
})
