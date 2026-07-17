import { describe, expect, test } from 'bun:test'
import { parseSshTarget } from '@/build/sftp/connection.ts'

describe('parseSshTarget', () => {
    test('parses host and optional port', () => {
        expect(parseSshTarget('root@pve.example.com')).toEqual({
            user: 'root',
            host: 'pve.example.com',
            port: 22,
        })
        expect(parseSshTarget('root@pve.example.com:2222')).toEqual({
            user: 'root',
            host: 'pve.example.com',
            port: 2222,
        })
    })

    test('supports bracketed IPv6', () => {
        expect(parseSshTarget('root@[2001:db8::1]:2222')).toEqual({
            user: 'root',
            host: '2001:db8::1',
            port: 2222,
        })
    })
})
