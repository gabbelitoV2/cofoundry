import { remoteStreaming } from '@/build/remote.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshOk } from '@/bootstrap/remote.ts'

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'

export const packerInstallScript = `set -euo pipefail
repo_list=/etc/apt/sources.list.d/hashicorp.list
keyring=/usr/share/keyrings/hashicorp-archive-keyring.gpg

# A previous interrupted bootstrap may have left this specific source malformed.
# Remove it before using APT to install missing download/key prerequisites.
if ! command -v wget >/dev/null 2>&1 || ! command -v gpg >/dev/null 2>&1; then
    rm -f "$repo_list"
    apt-get update
    ${APT_INSTALL} wget gpg
fi

. /etc/os-release
codename="${'${VERSION_CODENAME:-${DEBIAN_CODENAME:-${UBUNTU_CODENAME:-}}}'}"
case "$codename" in
    '') echo 'could not determine Debian/Ubuntu codename from /etc/os-release' >&2; exit 1 ;;
    *[!a-zA-Z0-9._-]*) echo "unsafe OS codename: $codename" >&2; exit 1 ;;
esac

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
wget -qO- https://apt.releases.hashicorp.com/gpg |
    gpg --batch --yes --dearmor -o "$tmpdir/hashicorp.gpg"
test -s "$tmpdir/hashicorp.gpg"
printf 'deb [signed-by=%s] https://apt.releases.hashicorp.com %s main\n' \
    "$keyring" "$codename" > "$tmpdir/hashicorp.list"

install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
install -m 0644 "$tmpdir/hashicorp.gpg" "$keyring"
# Overwrite the source atomically before APT reads it, repairing malformed files
# left by the old bootstrap command.
install -m 0644 "$tmpdir/hashicorp.list" "$repo_list"
apt-get update
${APT_INSTALL} packer
`

export const stepPacker: BootstrapStep = {
    id: 'packer',
    label: 'install packer',
    probe: async plan =>
        (await sshOk(plan.target, 'command -v packer >/dev/null 2>&1'))
            ? { done: true, note: 'packer already installed' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, packerInstallScript)
        return { note: 'installed' }
    },
}

export const stepAwscli: BootstrapStep = {
    id: 'awscli',
    label: 'install awscli',
    probe: async plan =>
        (await sshOk(plan.target, 'command -v aws >/dev/null 2>&1'))
            ? { done: true, note: 'aws already installed' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(
            plan.target,
            `apt-get update && ${APT_INSTALL} awscli`
        )
        return { note: 'installed' }
    },
}

export const stepIsoCache: BootstrapStep = {
    id: 'iso-cache',
    label: 'create /var/lib/cofoundry/iso-cache',
    probe: async plan =>
        (await sshOk(plan.target, '[ -d /var/lib/cofoundry/iso-cache ]'))
            ? { done: true, note: 'already exists' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(
            plan.target,
            'mkdir -p /var/lib/cofoundry/iso-cache'
        )
        return { note: 'created' }
    },
}
