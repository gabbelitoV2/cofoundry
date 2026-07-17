import type { BootstrapStep } from '@/bootstrap/model.ts'
import { stepToken } from '@/bootstrap/auth.ts'
import { stepAwscli, stepIsoCache, stepPacker } from '@/bootstrap/packages.ts'
import {
    stepBuildNetworkPreflight,
    stepBuildNetFirewall,
    stepDnsmasq,
    stepDnsmasqConf,
    stepNetslotDir,
    stepVmbr1,
} from '@/bootstrap/network.ts'

export { stepToken } from '@/bootstrap/auth.ts'
export const ALL_STEPS: BootstrapStep[] = [
    stepToken,
    stepPacker,
    stepAwscli,
    stepIsoCache,
    stepBuildNetworkPreflight,
    stepVmbr1,
    stepBuildNetFirewall,
    stepDnsmasq,
    stepDnsmasqConf,
    stepNetslotDir,
]
