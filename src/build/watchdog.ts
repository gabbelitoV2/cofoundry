/**
 * Build a remote Bash watchdog that restarts an installer VM when it powers
 * off before its communicator becomes stable. The script exits once SSH/WinRM
 * is reachable across three consecutive checks and tears itself down with the
 * launching shell.
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
      echo "[watchdog] VM ${vmid}: restart limit reached, giving up" >&2; exit 1
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
