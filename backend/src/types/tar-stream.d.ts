declare module 'tar-stream' {
  import { Writable, Readable } from 'node:stream';

  interface Header { name: string; type?: string; size?: number }
  type ExtractStream = Readable;
  interface Extract extends Writable {
    on(event: 'entry', listener: (header: Header, stream: ExtractStream, next: (error?: Error) => void) => void): this;
  }
  interface Pack extends Readable {
    entry(header: Header, body: Buffer, callback?: () => void): void;
    finalize(): void;
  }
  function extract(): Extract;
  function pack(): Pack;
  const tar: { extract: typeof extract; pack: typeof pack };
  export default tar;
}
