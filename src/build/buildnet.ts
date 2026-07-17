// Defaults for a new build bridge plus helpers for deriving the complete /24
// layout from an existing bridge gateway. Bootstrap adopts an existing bridge;
// the allocator also reads the live bridge so builds never drift from it.

/** Third-octet prefix of the /24 build subnet. */
export const BUILD_NET_PREFIX = '10.0.0'

/** CIDR of the build subnet (MASQUERADE source, host firewall rule source). */
export const BUILD_NET_CIDR = `${BUILD_NET_PREFIX}.0/24`

/** Default gateway for a newly created build bridge. */
export const BUILD_NET_GATEWAY = `${BUILD_NET_PREFIX}.1`

/** Default build-bridge address with prefix length. */
export const BUILD_NET_BRIDGE_ADDR = `${BUILD_NET_GATEWAY}/24`

// Per-build static DHCP reservations occupy the slot range
// BUILD_SLOT_BASE .. BUILD_SLOT_BASE + BUILD_SLOT_COUNT - 1 (.100-.149).
export const BUILD_SLOT_BASE = 100
export const BUILD_SLOT_COUNT = 50

/** Dynamic dnsmasq pool — kept clear of the static slot range above. */
export const BUILD_DHCP_RANGE_START = `${BUILD_NET_PREFIX}.200`
export const BUILD_DHCP_RANGE_END = `${BUILD_NET_PREFIX}.250`

export type BuildNetwork = {
    prefix: string
    cidr: string
    gateway: string
    bridgeAddress: string
    dhcpRangeStart: string
    dhcpRangeEnd: string
}

export const buildNetworkFromGateway = (gateway: string): BuildNetwork => {
    const octets = gateway.split('.')
    if (
        octets.length !== 4 ||
        octets.some(part => {
            const value = Number(part)
            return !/^\d+$/.test(part) || value < 0 || value > 255
        })
    ) {
        throw new Error(`invalid build-network IPv4 gateway: ${gateway}`)
    }
    const host = Number(octets[3])
    if (host === 0 || host === 255) {
        throw new Error(
            `build-network gateway is not a usable host: ${gateway}`
        )
    }
    const prefix = octets.slice(0, 3).join('.')
    return {
        prefix,
        cidr: `${prefix}.0/24`,
        gateway,
        bridgeAddress: `${gateway}/24`,
        dhcpRangeStart: `${prefix}.200`,
        dhcpRangeEnd: `${prefix}.250`,
    }
}
