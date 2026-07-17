export type BootstrapScope = 'linux-cloud' | 'with-installers'

export type BootstrapPlan = {
    target: string
    scope: BootstrapScope
    needBuildNet: boolean
    needTmpfs: boolean
    tokenName: string
    tmpfsSizeGB: number
}

export type ProbeResult = { done: boolean; note?: string }
export type ApplyResult = {
    note?: string
    secret?: string
    tokenId?: string
}

export type BootstrapStep = {
    id: string
    label: string
    inScope: (plan: BootstrapPlan) => boolean
    probe: (plan: BootstrapPlan) => Promise<ProbeResult>
    apply: (plan: BootstrapPlan) => Promise<ApplyResult>
}
