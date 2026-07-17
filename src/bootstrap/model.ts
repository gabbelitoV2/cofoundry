export type BootstrapPlan = {
    target: string
    tokenName: string
    buildDns: string
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
    probe: (plan: BootstrapPlan) => Promise<ProbeResult>
    apply: (plan: BootstrapPlan) => Promise<ApplyResult>
}
