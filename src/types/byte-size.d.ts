declare module 'byte-size' {
    interface ByteSize {
        value: string
        unit: string
        long: string
        toString(): string
    }
    function byteSize(bytes: number, options?: Record<string, unknown>): ByteSize
    export default byteSize
}
