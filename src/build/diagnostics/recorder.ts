import { shellQuote } from '@/util.ts'
import {
    DIAG_TMPFS_BASE,
    diagnosticsRemoteDir,
} from '@/build/diagnostics/paths.ts'
import type { GuestLogSpec } from '@/build/diagnostics/guest-logs.ts'

export type RecorderOptions = {
    intervalSec?: number
    maxFrames?: number
    /** Skip a capture when the tmpfs has less than this free (KiB). */
    minFreeKb?: number
    /** Hard backstop: exit the recorder after this many seconds no matter what. */
    maxLifetimeSec: number
    /** 0 disables in-guest log capture. */
    guestLogIntervalSec?: number
    guestLogs?: GuestLogSpec[]
}

const DEFAULTS = {
    intervalSec: 5,
    maxFrames: 30,
    minFreeKb: 32768, // 32 MiB
    guestLogIntervalSec: 60,
}

/** A hard lifetime backstop, comfortably above the longest real build (Windows
 *  update rounds can take ~3h). */
export const recorderLifetimeSec = (isWindows: boolean): number =>
    isWindows ? 6 * 3600 : 2 * 3600

/**
 * Reap diagnostics dirs left by a build that was SIGKILLed or lost to power loss
 * (where the recorder's traps never ran). Belt-and-suspenders alongside the
 * per-build cleanup, mirroring how netslot reclaims orphaned slots.
 */
export const sweepStaleDiagnosticsCommand = (maxAgeMin = 360): string =>
    `find ${shellQuote(DIAG_TMPFS_BASE)} -mindepth 1 -maxdepth 1 -type d -mmin +${maxAgeMin} -exec rm -rf {} + 2>/dev/null || true`

// Bash that, every `intervalSec`, snapshots each in-guest log through the guest
// agent. Each capture writes to a temp file and only replaces the kept copy when
// the agent actually returned something — during a Linux autoinstall the agent
// isn't up yet (it lives in the installed system, not the live installer), so
// this never clobbers a good capture or leaves a 0-byte file behind. Empty when
// disabled or when the family has no specs.
const guestLogBlock = (
    vmid: number,
    dir: string,
    specs: GuestLogSpec[],
    intervalSec: number
): string => {
    if (intervalSec <= 0 || specs.length === 0) return ''
    const captures = specs
        .map(spec => {
            const argv = spec.argv.map(shellQuote).join(' ')
            const out = shellQuote(`${dir}/logs/${spec.name}.json`)
            return (
                `      qm guest exec ${vmid} --timeout 15 -- ${argv} > ${out}.tmp 2>/dev/null || true\n` +
                `      [ -s ${out}.tmp ] && mv -f ${out}.tmp ${out}; rm -f ${out}.tmp 2>/dev/null || true`
            )
        })
        .join('\n')
    return `    if [ $(( $(date +%s) - _lastlog )) -ge ${intervalSec} ]; then
      _lastlog=$(date +%s)
${captures}
    fi
`
}

/**
 * A background Bash recorder, prepended to the remote build script alongside
 * `buildVmWatchdog`. It screendumps the emulated framebuffer into a tmpfs ring
 * buffer every few seconds — so even though Packer deletes the VM on failure,
 * the last frames survive to show the GRUB menu / installer error / auto-logon
 * that Packer's own log can't — and periodically snapshots the recipe's in-guest
 * log area via the guest agent.
 *
 * Guarded four ways so it can never outlive its build or fill the node: an
 * orphan check (parent reparented to init), a hard max-lifetime backstop, a
 * free-space guard, and a fixed-size ring buffer. Its EXIT/signal traps also
 * tear down the watchdog (`$_WDOG_PID`, when set), because appending this after
 * the watchdog would otherwise replace the watchdog's own traps.
 */
export const buildDiagnosticsRecorder = (
    vmid: number,
    opts: RecorderOptions
): string => {
    const interval = opts.intervalSec ?? DEFAULTS.intervalSec
    const maxFrames = opts.maxFrames ?? DEFAULTS.maxFrames
    const minFreeKb = opts.minFreeKb ?? DEFAULTS.minFreeKb
    const guestInt = opts.guestLogIntervalSec ?? DEFAULTS.guestLogIntervalSec
    const dir = diagnosticsRemoteDir(vmid)
    const logs = guestLogBlock(vmid, dir, opts.guestLogs ?? [], guestInt)

    return `
(
  _dir=${shellQuote(dir)}
  mkdir -p "$_dir/frames" "$_dir/logs" 2>/dev/null || exit 0
  chmod 700 "$_dir" 2>/dev/null || true

  # HMP syntax is: screendump FILE [-f FORMAT]. Probe once whether this QEMU was
  # built with libpng (PVE's pve-qemu often is NOT); otherwise fall back to PPM,
  # which every build supports. Raw PPM is ~3 MB/frame, so PPM frames are gzipped
  # (a text-mode installer console compresses ~70x) to keep the ring small.
  _ffmt="" _ext="ppm.gz"
  if echo "screendump $_dir/.probe -f png" | timeout 10 qm monitor ${vmid} >/dev/null 2>&1 && [ -s "$_dir/.probe" ]; then
    _ffmt=" -f png"; _ext="png"
  fi
  rm -f "$_dir/.probe" 2>/dev/null || true

  _start=$(date +%s) _lastlog=0
  while true; do
    # Guard: launching shell gone, or past the hard lifetime backstop.
    [ "$(ps -o ppid= -p $BASHPID 2>/dev/null | tr -d ' ')" = "1" ] && break
    [ $(( $(date +%s) - _start )) -ge ${opts.maxLifetimeSec} ] && { echo "[diag] max lifetime reached — exiting" >&2; break; }

    # Capture a frame, unless the tmpfs is tight (a missing diagnostic beats a
    # full filesystem), then trim the ring to its last ${maxFrames} frames.
    _avail=$(df -Pk ${shellQuote(DIAG_TMPFS_BASE)} 2>/dev/null | awk 'NR==2{print $4}')
    if [ -n "$_avail" ] && [ "$_avail" -ge ${minFreeKb} ]; then
      _raw="$_dir/frames/frame-$(date +%s%N).\${_ext%.gz}"
      echo "screendump $_raw$_ffmt" | timeout 10 qm monitor ${vmid} >/dev/null 2>&1 || true
      if [ -s "$_raw" ]; then
        [ "$_ext" = "png" ] || gzip -f "$_raw" 2>/dev/null || true
      else
        rm -f "$_raw" 2>/dev/null || true
      fi
      ls -1t "$_dir"/frames/frame-* 2>/dev/null | tail -n +$(( ${maxFrames} + 1 )) | xargs -r rm -f 2>/dev/null || true
    fi
${logs}    sleep ${interval}
  done
) &
_DIAG_PID=$!
trap 'kill "$_DIAG_PID" "\${_WDOG_PID:-}" 2>/dev/null || true' EXIT
trap 'kill "$_DIAG_PID" "\${_WDOG_PID:-}" 2>/dev/null || true; kill 0 2>/dev/null || true; exit 143' HUP INT TERM
`
}
