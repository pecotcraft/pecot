// yauzl + yazl を PptxArchive ポートに適合させるアダプタ。
// XML mutate 対象のパーツ (slides/*, _rels/*) は addBuffer を使う。
// media (*.png 等の大型バイナリ) は addReadStreamLazy のパススルーで OOM を避ける。

// yauzl/yazl の ZipFile / Entry は内部状態を持つ mutable オブジェクトで、readonly 化できない。
// また yazl/yauzl callback は伝統的な Node 形式 (`null` 許容) で、unicorn/no-null と整合しない。
// そのため、これらの規則を本ファイル全体で無効化する。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types, unicorn/no-null */

import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'

import { type Entry, open as yauzlOpen, type ZipFile as YauzlZipFile } from 'yauzl'
import { ZipFile as YazlZipFile } from 'yazl'

import type {
  PptxArchive,
  PptxEntry,
  PptxReader,
  PptxWriter,
} from '../../domain/_shared/ports.js'

class YauzlPptxReader implements PptxReader {
  private readonly zipFile: YauzlZipFile
  private readonly entryMap: ReadonlyMap<string, Entry>
  private closed = false

  constructor(zipFile: YauzlZipFile, entryMap: ReadonlyMap<string, Entry>) {
    this.zipFile = zipFile
    this.entryMap = entryMap
  }

  async read(part: string): Promise<Buffer> {
    if (this.closed) {
      throw new Error(`PptxReader: archive is already closed (cannot read ${part})`)
    }
    const entry = this.entryMap.get(part)
    if (entry === undefined) {
      throw new Error(`PptxReader: part not found in archive: ${part}`)
    }
    const stream = await openReadStream(this.zipFile, entry)
    return drainToBuffer(stream)
  }

  entries(): AsyncIterable<PptxEntry> {
    if (this.closed) {
      throw new Error('PptxReader: archive is already closed (cannot enumerate)')
    }
    const zipFile = this.zipFile
    const map = this.entryMap
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<PptxEntry> => {
        const iterator = map.entries()[Symbol.iterator]()
        return {
          next: (): Promise<IteratorResult<PptxEntry>> => {
            const next = iterator.next()
            if (next.done === true) {
              return Promise.resolve({ done: true, value: undefined })
            }
            const [part, entry] = next.value
            const value: PptxEntry = {
              part,
              read: async (): Promise<Buffer> => {
                const stream = await openReadStream(zipFile, entry)
                return drainToBuffer(stream)
              },
            }
            return Promise.resolve({ done: false, value })
          },
        }
      },
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.zipFile.close()
    }
    return Promise.resolve()
  }
}

class YazlPptxWriter implements PptxWriter {
  private readonly zipFile: YazlZipFile = new YazlZipFile()

  addBuffer(part: string, buffer: Readonly<Buffer>): void {
    // yazl 側は readonly を期待しないため値コピーで渡す。
    this.zipFile.addBuffer(Buffer.from(buffer), part)
  }

  addReadStream(part: string, getStream: () => NodeJS.ReadableStream): void {
    this.zipFile.addReadStreamLazy(part, (callback) => {
      // 実装上 getStream() の失敗は ZipFile に伝播させる。
      // yazl の lazy callback は readStream が無効でも err 経由で伝播可能。
      const stream = getStream()
      callback(null, stream)
    })
  }

  finish(outputPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 出力 path は CLI 上位層で検証済の引数
      const writeStream = createWriteStream(outputPath)
      writeStream.on('error', reject)
      writeStream.on('finish', resolve)
      this.zipFile.outputStream.on('error', reject)
      this.zipFile.outputStream.pipe(writeStream)
      this.zipFile.end()
    })
  }
}

export class YauzlYazlPptxArchive implements PptxArchive {
  async read(path: string): Promise<PptxReader> {
    const zipFile = await openZipFile(path)
    const entryMap = await collectEntries(zipFile)
    return new YauzlPptxReader(zipFile, entryMap)
  }

  write(): PptxWriter {
    return new YazlPptxWriter()
  }
}

function openZipFile(path: string): Promise<YauzlZipFile> {
  return new Promise((resolve, reject) => {
    yauzlOpen(
      path,
      { lazyEntries: true, autoClose: false },
      (error, zipFile) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(zipFile)
      },
    )
  })
}

function collectEntries(zipFile: YauzlZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const map = new Map<string, Entry>()
    zipFile.on('entry', (entry: Entry) => {
      // ディレクトリエントリ（末尾 '/'）はスキップ
      if (!entry.fileName.endsWith('/')) {
        map.set(entry.fileName, entry)
      }
      zipFile.readEntry()
    })
    zipFile.on('end', () => {
      resolve(map)
    })
    zipFile.on('error', reject)
    zipFile.readEntry()
  })
}

function openReadStream(
  zipFile: YauzlZipFile,
  entry: Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      /* c8 ignore next 4 -- 健全な entry に対する openReadStream の error の分岐は実テストで再現困難 */
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stream)
    })
  })
}

function drainToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) => {
      /* c8 ignore next -- yauzl の openReadStream は string モードを使わないため到達不能 */
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    stream.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', reject)
  })
}
