// zip (xlsx) の全エントリを格納順のまま Map に読み出す。
// evidence-xlsx のテストは、「エントリ構成と順序」と「media の byte 一致」を見る。
// そのため pptx 用の PptxReader ポート (part 名でのランダムアクセス) ではなく、素の yauzl を使う。

// yauzl の ZipFile / Entry は内部状態を持つ mutable オブジェクトで readonly 化できない
// (archive.ts と同流儀でファイル全体を無効化する)。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import { open as yauzlOpen, type Entry, type ZipFile } from 'yauzl'

/**
格納順を保った Map (キー = zip 内パス)。ディレクトリエントリは除く。
*/
export function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzlOpen(zipPath, { lazyEntries: true }, (error: Error | null, zipFile: ZipFile) => {
      if (error !== null) {
        reject(error)
        return
      }
      const entries = new Map<string, Buffer>()
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError: Error | null, stream) => {
          if (streamError !== null) {
            reject(streamError)
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zipFile.readEntry()
          })
          stream.on('error', reject)
        })
      })
      zipFile.on('end', () => {
        resolve(entries)
      })
      zipFile.on('error', reject)
      zipFile.readEntry()
    })
  })
}

/**
part の内容を UTF-8 文字列で取り出す。未存在は明示的に失敗させる。
*/
export function entryText(entries: ReadonlyMap<string, Buffer>, part: string): string {
  const buffer = entries.get(part)
  if (buffer === undefined) {
    throw new Error(`zip に ${part} がありません (実在: ${entries.keys().toArray().join(', ')})`)
  }
  return buffer.toString('utf8')
}
