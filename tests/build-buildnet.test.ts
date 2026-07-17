import { describe, expect, test } from 'bun:test'
import { buildNetworkFromGateway } from '@/build/buildnet.ts'

describe('buildNetworkFromGateway', () => {
    test('derives the complete /24 layout from its gateway', () => {
        expect(buildNetworkFromGateway('10.10.10.1')).toEqual({
            prefix: '10.10.10',
            cidr: '10.10.10.0/24',
            gateway: '10.10.10.1',
            bridgeAddress: '10.10.10.1/24',
            dhcpRangeStart: '10.10.10.200',
            dhcpRangeEnd: '10.10.10.250',
        })
    })

    test('rejects an invalid gateway', () => {
        expect(() => buildNetworkFromGateway('10.10.999.1')).toThrow()
    })
})
