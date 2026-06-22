// Single source of truth for the per-node NAT "build network" carried on the
// vmbr1 bridge. The bridge config, the host MASQUERADE + firewall rules, the
// dnsmasq DHCP service, and the per-build static IP slots all derive from the
// constants here — change BUILD_NET_PREFIX and the whole design moves together
// instead of drifting across bootstrap.ts and netslot.ts.
//
// The subnet is a /24. 10.0.0.0/24 is a common LAN range, so if a node's own
// network ever collides with it, this is the one place to repoint it.

/** Third-octet prefix of the /24 build subnet. */
export const BUILD_NET_PREFIX = '10.0.0'

/** CIDR of the build subnet (MASQUERADE source, host firewall rule source). */
export const BUILD_NET_CIDR = `${BUILD_NET_PREFIX}.0/24`

/** Gateway / vmbr1 host address (dnsmasq router, per-build slot gateway). */
export const BUILD_NET_GATEWAY = `${BUILD_NET_PREFIX}.1`

/** vmbr1 interface address with prefix length, for /etc/network/interfaces. */
export const BUILD_NET_BRIDGE_ADDR = `${BUILD_NET_GATEWAY}/24`

// Per-build static DHCP reservations occupy the slot range
// BUILD_SLOT_BASE .. BUILD_SLOT_BASE + BUILD_SLOT_COUNT - 1 (10.0.0.100-149).
export const BUILD_SLOT_BASE = 100
export const BUILD_SLOT_COUNT = 50

/** Dynamic dnsmasq pool — kept clear of the static slot range above. */
export const BUILD_DHCP_RANGE_START = `${BUILD_NET_PREFIX}.200`
export const BUILD_DHCP_RANGE_END = `${BUILD_NET_PREFIX}.250`
