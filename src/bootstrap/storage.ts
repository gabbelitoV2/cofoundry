import { remoteStreaming } from '@/build/remote.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshCapture } from '@/bootstrap/remote.ts'

export const parseSizeToBytes = (s: string): number => {
    const m = s.trim().match(/^(\d+)\s*([KMGTkmgt]?)$/)
    if (!m) return 0
    const n = parseInt(m[1]!, 10)
    const unit = (m[2] ?? '').toUpperCase()
    const mult =
        unit === 'K'
            ? 1024
            : unit === 'M'
              ? 1024 ** 2
              : unit === 'G'
                ? 1024 ** 3
                : unit === 'T'
                  ? 1024 ** 4
                  : 1
    return n * mult
}

export const stepTmpfs: BootstrapStep = {
    id: 'tmpfs',
    label: 'enlarge /tmp tmpfs',
    inScope: plan => plan.needTmpfs,
    probe: async plan => {
        const fstab = await sshCapture(
            plan.target,
            `awk '$2=="/tmp" && $3=="tmpfs" {print $4}' /etc/fstab`
        )
        const opts = fstab.stdout.trim()
        if (!opts) return { done: false }
        const m = opts.match(/size=([^,\s]+)/)
        if (!m) return { done: false }
        const haveBytes = parseSizeToBytes(m[1]!)
        const wantBytes = plan.tmpfsSizeGB * 1024 ** 3
        return haveBytes >= wantBytes
            ? { done: true, note: `fstab already size=${m[1]}` }
            : { done: false, note: `fstab size=${m[1]} < ${plan.tmpfsSizeGB}G` }
    },
    apply: async plan => {
        // Replace an existing tmpfs /tmp line, otherwise append one.
        const want = `tmpfs /tmp tmpfs defaults,size=${plan.tmpfsSizeGB}G 0 0`
        const cmd = `
if awk '$2=="/tmp" && $3=="tmpfs" {found=1} END {exit !found}' /etc/fstab; then
    sed -i -E 's|^[^#].*[[:space:]]/tmp[[:space:]]+tmpfs[[:space:]].*|${want.replace(/[|]/g, '\\|')}|' /etc/fstab
else
    echo '${want}' >> /etc/fstab
fi
mount -o remount /tmp
`.trim()
        await remoteStreaming(plan.target, cmd)
        return { note: `set to ${plan.tmpfsSizeGB}G + remounted` }
    },
}
