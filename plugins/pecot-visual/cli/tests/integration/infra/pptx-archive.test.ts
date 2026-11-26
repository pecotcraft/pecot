// 本物の yauzl + yazl を相手にした integration test。モック禁止。

/* eslint-disable security/detect-non-literal-fs-filename -- テスト内のファイル参照は信頼できる */

import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { YauzlYazlPptxArchive } from '../../../src/infra/pptx-ooxml/archive.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const HERE = import.meta.dirname
const DUMMY_PPTX = path.join(
  HERE,
  '..',
  '..',
  'fixtures',
  'pptx',
  'dummy.pptx',
)

const EXPECTED_PARTS: readonly string[] = [
  '[Content_Types].xml',
  '_rels/.rels',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
  'ppt/slides/slide1.xml',
  'ppt/slides/_rels/slide1.xml.rels',
]

const temporaryDirectory = useTemporaryDirectory('pptx-archive-test-')

afterEach(() => {
  rmSync(temporaryDirectory(), { recursive: true, force: true })
})

describe('YauzlYazlPptxArchive', () => {
  it('アーカイブを読み込むと、すべてのパートを Buffer として取得できる', async () => {
    await explains('`YauzlYazlPptxArchive` の読み込みのテストです。`dummy.pptx` の 6 つのパートを `read` した場合に、どのパートも空でない Buffer として返ることを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    try {
      for (const part of EXPECTED_PARTS) {
        const buffer = await reader.read(part)
        expect(buffer.length).toBeGreaterThan(0)
      }
    }
    finally {
      await reader.close()
    }
  })

  it('entries を反復すると、すべてのパートを順に返す', async () => {
    await explains('`entries()` の非同期反復のテストです。`dummy.pptx` を反復した場合に、6 つのパートがすべて返り、それぞれの `read` が空でない Buffer を返すことを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    const observed: string[] = []
    try {
      for await (const entry of reader.entries()) {
        observed.push(entry.part)
        const buffer = await entry.read()
        expect(buffer.length).toBeGreaterThan(0)
      }
    }
    finally {
      await reader.close()
    }
    expect(observed.toSorted(compareStrings)).toEqual([...EXPECTED_PARTS].toSorted(compareStrings))
  })

  it('存在しないパートを read すると、エラーが発生する', async () => {
    await explains('存在しないパートの読み込みのテストです。`does/not/exist.xml` を `read` した場合に、`not found` を含むエラーで失敗することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    try {
      await expect(reader.read('does/not/exist.xml')).rejects.toThrow(/not found/)
    }
    finally {
      await reader.close()
    }
  })

  it('close の後に read を呼び出すと、エラーが発生する', async () => {
    await explains('閉じた後の読み込みのテストです。`close` の後で `read` を呼び出した場合に、`closed` を含むエラーで失敗することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    await expect(reader.read('ppt/presentation.xml')).rejects.toThrow(/closed/)
  })

  it('close の後に entries を呼び出すと、エラーが発生する', async () => {
    await explains('閉じた後の列挙のテストです。`close` の後で `entries` を呼び出した場合に、`closed` を含む例外が発生することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    expect(() => reader.entries()).toThrow(/closed/)
  })

  it('close を 2 回呼び出しても、エラーにならない', async () => {
    await explains('`close` の呼び出しのテストです。`close` を 2 回続けて呼び出した場合に、2 回目も正常に完了することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    await expect(reader.close()).resolves.toBeUndefined()
  })

  it('write は addBuffer と addReadStream のどちらでもパートを追加でき、再読み込みで内容が一致する', async () => {
    await explains('アーカイブの書き出しのテストです。XML を `addBuffer` で、それ以外を `addReadStream` で追加して書き出した場合に、再読み込みした全パートの内容が元の `dummy.pptx` と一致することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    const writer = archive.write()
    try {
      for await (const entry of reader.entries()) {
        const buffer = await entry.read()
        // XML mutate 対象は addBuffer、それ以外（架空の media と仮定）は addReadStream パススルー
        if (entry.part.endsWith('.xml') || entry.part.endsWith('.rels')) {
          writer.addBuffer(entry.part, buffer)
        }
        else {
          // dummy.pptx には media は無いがコードパス確認のためのフォールバック
          writer.addReadStream(entry.part, () => Readable.from(buffer))
        }
      }
    }
    finally {
      await reader.close()
    }

    const outPath = temporaryDirectory('roundtrip.pptx')
    await writer.finish(outPath)

    // 再読込して全 part の中身が一致することを確認
    const archive2 = new YauzlYazlPptxArchive()
    const reader2 = await archive2.read(outPath)
    try {
      for (const part of EXPECTED_PARTS) {
        const original = await new YauzlYazlPptxArchive().read(DUMMY_PPTX)
        const originalBuffer = await original.read(part)
        await original.close()
        const newBuffer = await reader2.read(part)
        expect(newBuffer.equals(originalBuffer)).toBe(true)
      }
    }
    finally {
      await reader2.close()
    }
  })

  it('addReadStream で追加したバイナリは、加工せずに保持する', async () => {
    await explains('バイナリのパートの書き出しのテストです。PNG の署名を含むバイト列を `addReadStream` で追加して書き出した場合に、読み込んだ内容が元のバイト列と一致し、`addBuffer` の XML も保持されることを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const writer = archive.write()
    const fakeMedia = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF])
    writer.addBuffer('xml.xml', Buffer.from('<a/>'))
    writer.addReadStream('ppt/media/fake.png', () => Readable.from(fakeMedia))
    const outPath = temporaryDirectory('media.zip')
    await writer.finish(outPath)

    const reader = await archive.read(outPath)
    try {
      const got = await reader.read('ppt/media/fake.png')
      expect(got.equals(fakeMedia)).toBe(true)
      const xml = await reader.read('xml.xml')
      expect(xml.toString('utf8')).toBe('<a/>')
    }
    finally {
      await reader.close()
    }
  })

  it('存在しないファイルを読み込むと、エラーで失敗する', async () => {
    await explains('存在しないファイルの読み込みのテストです。存在しない pptx のパスを `read` した場合に、`Error` で失敗することを確認します。')
    const archive = new YauzlYazlPptxArchive()
    await expect(archive.read(temporaryDirectory('does-not-exist.pptx'))).rejects.toBeInstanceOf(Error)
  })

  it('空ファイルなど不正な ZIP を読み込むと、エラーで失敗する', async () => {
    await explains('不正な ZIP の読み込みのテストです。空のファイルを `read` した場合に、`Error` で失敗することを確認します。')
    const badPath = temporaryDirectory('bad.pptx')
    // 空ファイルは ZIP として不正 → yauzl.open が err を返す
    const { writeFileSync } = await import('node:fs')
    writeFileSync(badPath, Buffer.alloc(0))
    const archive = new YauzlYazlPptxArchive()
    await expect(archive.read(badPath)).rejects.toBeInstanceOf(Error)
  })

  it('ディレクトリのエントリはスキップし、ファイルのエントリだけを返す', async () => {
    await explains('ディレクトリのエントリを含む ZIP の読み込みのテストです。`inside/file.txt` とディレクトリ `inside/` を含む ZIP を反復した場合に、ファイルのエントリ `inside/file.txt` だけが返ることを確認します。')
    // yazl を直接使って「ディレクトリ entry を含む ZIP」を作り yauzl 経由で読む。
    // 実装 (collectEntries) の "/" 末尾スキップ分岐をカバーする。
    const yazl = await import('yazl')
    const { createWriteStream } = await import('node:fs')
    const outPath = temporaryDirectory('with-dir.zip')
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile()
      zip.addBuffer(Buffer.from('x'), 'inside/file.txt')
      zip.addEmptyDirectory('inside/')
      const ws = createWriteStream(outPath)
      ws.on('finish', resolve)
      ws.on('error', reject)
      zip.outputStream.pipe(ws)
      zip.end()
    })

    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(outPath)
    try {
      const observed: string[] = []
      for await (const entry of reader.entries()) {
        observed.push(entry.part)
      }
      expect(observed).toEqual(['inside/file.txt'])
    }
    finally {
      await reader.close()
    }
  })

  it('finish を呼び出すと、指定したパスへ ZIP を書き出す', async () => {
    await explains('`finish` の書き出しのテストです。1 つのパートを追加して `finish` を呼び出した場合に、書き出したファイルの先頭が ZIP の署名 `PK\\x03\\x04` になることを確認します。')
    const archive = new YauzlYazlPptxArchive()
    const writer = archive.write()
    writer.addBuffer('a.txt', Buffer.from('hello'))
    const outPath = temporaryDirectory('mini.zip')
    await writer.finish(outPath)
    const written = readFileSync(outPath)
    // ZIP local file header magic: PK\x03\x04
    expect(written.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]))
  })
})
