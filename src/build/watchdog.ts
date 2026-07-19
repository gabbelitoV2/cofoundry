/**
 * Build a remote Bash watchdog that restarts an installer VM when it powers
 * off before its communicator becomes stable. The script exits once SSH/WinRM
 * is reachable across three consecutive checks and tears itself down with the
 * launching shell. When the restart limit is reached it signals the whole
 * process group so the running Packer attempt fails immediately instead of
 * waiting out its communicator timeout against a dead VM.
 */
export const buildVmWatchdog = (
    vmid: number,
    buildIp: string,
    communicatorPort: number,
    feedBootKeys: boolean
): string => `
(
  _n=0 _max=5 _up=0 _need=3
  while true; do
    if [ "$(ps -o ppid= -p $BASHPID 2>/dev/null | tr -d ' ')" = "1" ]; then
      echo "[watchdog] launching shell gone — exiting"; exit 0
    fi
    sleep 10
    if timeout 3 bash -c "echo >/dev/tcp/${buildIp}/${communicatorPort}" 2>/dev/null; then
      _up=$((_up + 1))
      if [ "$_up" -ge "$_need" ]; then
        echo "[watchdog] port ${communicatorPort} up on ${buildIp} (stable) — exiting"; exit 0
      fi
      continue
    fi
    _up=0
    _s=$(qm status ${vmid} 2>/dev/null | awk 'NR==1{print $2}') || continue
    [ "$_s" = "stopped" ] || continue
    sleep 20
    _s=$(qm status ${vmid} 2>/dev/null | awk 'NR==1{print $2}') || continue
    [ "$_s" = "stopped" ] || continue
    if qm config ${vmid} 2>/dev/null | grep -q '^template:'; then
      echo "[watchdog] VM ${vmid} is now a template — exiting"; exit 0
    fi
    _n=$((_n + 1))
    if [ "$_n" -gt "$_max" ]; then
      echo "[watchdog] VM ${vmid}: restart limit reached — failing this build attempt" >&2
      # A bare exit would only end this background subshell while Packer keeps
      # waiting for SSH/WinRM against the dead VM until its communicator
      # timeout. sshd starts the launching shell in its own session (setsid),
      # so signalling process group 0 fells exactly this attempt — packer,
      # tail, the recorder, and the launching shell, whose TERM trap then
      # re-raises and exits 143 — mirroring the traps below.
      kill 0 2>/dev/null || true
      exit 1
    fi
    echo "[watchdog] VM ${vmid} stopped unexpectedly (attempt $_n/$_max) — restarting"
    qm start ${vmid} 2>&1 || true
${
    feedBootKeys
        ? `    # Feed Enter across the OVMF boot-from-CD prompt window.
    ( for _k in $(seq 1 60); do qm sendkey ${vmid} ret 2>/dev/null || true; sleep 1; done ) &
`
        : ''
}  done
) &
_WDOG_PID=$!
trap 'kill "$_WDOG_PID" 2>/dev/null || true' EXIT
trap 'kill "$_WDOG_PID" 2>/dev/null || true; kill 0 2>/dev/null || true; exit 143' HUP INT TERM
`
