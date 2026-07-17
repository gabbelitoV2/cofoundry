import { describe, expect, test } from 'bun:test'
import {
    buildNetworkRouteConflict,
    dnsmasqConflict,
} from '@/bootstrap/network.ts'

describe('buildNetworkRouteConflict', () => {
    test('detects exact and broader overlapping routes', () => {
        expect(
            buildNetworkRouteConflict(
                '10.0.0.0/24 dev vmbr0 proto kernel scope link'
            )
        ).toContain('10.0.0.0/24')
        expect(
            buildNetworkRouteConflict('10.0.0.0/8 via 192.168.1.1 dev vmbr0')
        ).toContain('10.0.0.0/8')
    })

    test('allows default, unrelated, and Cofoundry bridge routes', () => {
        const routes = [
            'default via 192.168.1.1 dev vmbr0',
            '192.168.1.0/24 dev vmbr0 proto kernel scope link',
            '10.0.0.0/24 dev vmbr1 proto kernel scope link',
        ].join('\n')
        expect(buildNetworkRouteConflict(routes)).toBeUndefined()
    })
})

describe('dnsmasqConflict', () => {
    test('allows one systemd-managed instance scoped to another interface', () => {
        const config = '/etc/dnsmasq.d/lan.conf:1:interface=vmbr0'
        const listeners =
            'udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=1,fd=4))'
        expect(dnsmasqConflict('1|active', config, listeners)).toBeUndefined()
    })

    test('rejects multiple or unmanaged instances', () => {
        expect(dnsmasqConflict('2|active', '', '')).toContain(
            '2 dnsmasq processes'
        )
        expect(dnsmasqConflict('1|inactive', '', '')).toContain(
            'outside the system'
        )
    })

    test('rejects existing ownership of the build network', () => {
        expect(
            dnsmasqConflict(
                '1|active',
                '/etc/dnsmasq.d/lan.conf:3:dhcp-range=10.0.0.20,10.0.0.40,12h',
                ''
            )
        ).toContain('already owns')
    })

    test('rejects an unscoped existing configuration', () => {
        expect(
            dnsmasqConflict(
                '1|active',
                '/etc/dnsmasq.d/lan.conf:1:server=1.1.1.1',
                ''
            )
        ).toContain('not scoped')
    })

    test('rejects an existing default daemon listening on all interfaces', () => {
        const listeners =
            'udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=1,fd=4))'
        expect(dnsmasqConflict('1|active', '', listeners)).toContain(
            'listens on all interfaces'
        )
    })

    test('rejects another wildcard DNS or DHCP listener', () => {
        const listeners =
            'tcp LISTEN 0 4096 0.0.0.0:53 0.0.0.0:* users:(("named",pid=2,fd=5))'
        expect(dnsmasqConflict('0|inactive', '', listeners)).toContain(
            'another service'
        )
    })
})
