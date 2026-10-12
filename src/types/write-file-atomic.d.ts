declare module 'write-file-atomic' {
  interface WriteFileAtomicOptions {
    encoding?: BufferEncoding
    fsync?: boolean
    mode?: number
  }

  function writeFileAtomic(
    filename: string,
    data: string | Buffer,
    options?: WriteFileAtomicOptions,
  ): Promise<void>

  export default writeFileAtomic
}
