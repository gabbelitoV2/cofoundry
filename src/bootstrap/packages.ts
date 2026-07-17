import { remoteStreaming } from '@/build/remote.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshOk } from '@/bootstrap/remote.ts'

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'

export const stepPacker: BootstrapStep = {
    id: 'packer',
    label: 'install packer',
    inScope: () => true,
    probe: async plan =>
        (await sshOk(plan.target, 'command -v packer >/dev/null 2>&1'))
            ? { done: true, note: 'packer already installed' }
            : { done: false },
    apply: async plan => {
        const cmd = [
            'set -e',
            'install -d -m 0755 /usr/share/keyrings',
            'wget -qO- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg',
            `echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list`,
            'apt-get update',
            `${APT_INSTALL} packer`,
        ].join(' && ')
        await remoteStreaming(plan.target, cmd)
        return { note: 'installed' }
    },
}

export const stepAwscli: BootstrapStep = {
    id: 'awscli',
    label: 'install awscli',
    inScope: () => true,
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
    inScope: () => true,
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
