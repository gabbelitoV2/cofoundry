import type { BootstrapStep } from '@/bootstrap/model.ts'
import { stepToken } from '@/bootstrap/auth.ts'
import { stepAwscli, stepIsoCache, stepPacker } from '@/bootstrap/packages.ts'
import {
    stepBuildNetFirewall,
    stepDnsmasq,
    stepDnsmasqConf,
    stepNetslotDir,
    stepVmbr1,
} from '@/bootstrap/network.ts'
import { stepTmpfs } from '@/bootstrap/storage.ts'

export { stepToken } from '@/bootstrap/auth.ts'
export { parseSizeToBytes } from '@/bootstrap/storage.ts'

export const ALL_STEPS: BootstrapStep[] = [
    stepToken,
    stepPacker,
    stepAwscli,
    stepIsoCache,
    stepVmbr1,
    stepBuildNetFirewall,
    stepDnsmasq,
    stepDnsmasqConf,
    stepNetslotDir,
    stepTmpfs,
]
