import { describe, expect, test } from 'bun:test'
import {
    buildNetworkRouteConflict,
    dnsmasqConflict,
    dnsmasqConf,
    hasBuildBridgeAddress,
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

describe('hasBuildBridgeAddress', () => {
    test('accepts CIDR notation from ifquery or the live interface', () => {
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1/24\n', '')
        ).toBeTrue()
        expect(
            hasBuildBridgeAddress(
                '',
                '7: vmbr1 inet 10.0.0.1/24 scope global vmbr1'
            )
        ).toBeTrue()
    })

    test('accepts address plus dotted or prefix-length netmask', () => {
        expect(
            hasBuildBridgeAddress(
                '    address 10.0.0.1\n    netmask 255.255.255.0\n',
                ''
            )
        ).toBeTrue()
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1\n    netmask 24\n', '')
        ).toBeTrue()
    })

    test('rejects a different address or prefix', () => {
        expect(
            hasBuildBridgeAddress('    address 10.0.1.1/24\n', '')
        ).toBeFalse()
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1/16\n', '')
        ).toBeFalse()
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

    test('rejects a different range on the build network', () => {
        expect(
            dnsmasqConflict(
                '1|active',
                '/etc/dnsmasq.d/lan.conf:3:dhcp-range=10.0.0.20,10.0.0.40,12h',
                ''
            )
        ).toContain('different DHCP range')
    })

    test('allows compatible vmbr1 and build-range directives', () => {
        const config = [
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '/etc/dnsmasq.d/vmbr1.conf:2:dhcp-range=10.0.0.200,10.0.0.250,12h',
        ].join('\n')
        expect(dnsmasqConflict('1|active', config, '')).toBeUndefined()
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

describe('dnsmasqConf', () => {
    test('writes only directives missing from a compatible alternate file', () => {
        const config = [
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '/etc/dnsmasq.d/vmbr1.conf:2:bind-interfaces',
            '/etc/dnsmasq.d/vmbr1.conf:3:dhcp-range=10.0.0.200,10.0.0.250,12h',
            '/etc/dnsmasq.d/vmbr1.conf:4:dhcp-option=3,10.0.0.1',
            '/etc/dnsmasq.d/vmbr1.conf:5:dhcp-option=6,8.8.8.8',
        ].join('\n')
        expect(dnsmasqConf('1.1.1.1', config)).toBe(
            '# Managed by Cofoundry.\n' +
                'dhcp-hostsfile=/etc/dnsmasq.d/cofoundry-hosts.d\n'
        )
    })

    test('fills in the build network when only vmbr1 already exists', () => {
        const config = '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1'
        const generated = dnsmasqConf('1.1.1.1', config)
        expect(generated).not.toContain('\ninterface=vmbr1\n')
        expect(generated).toContain('dhcp-range=10.0.0.200,10.0.0.250,12h')
        expect(generated).toContain('dhcp-option=6,1.1.1.1')
        expect(generated).toContain(
            'dhcp-hostsfile=/etc/dnsmasq.d/cofoundry-hosts.d'
        )
    })
})
