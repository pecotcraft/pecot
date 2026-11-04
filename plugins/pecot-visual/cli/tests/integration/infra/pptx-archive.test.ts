// 本物の yauzl + yazl を相手にした integration test。モック禁止。

/* eslint-disable security/detect-non-literal-fs-filename -- テスト内のファイル参照は信頼できる */

import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { YauzlYazlPptxArchive } from '../../../src/infra/pptx-ooxml/archive.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

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
  it('read で全 part を Buffer として取得できる', async () => {
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

  it('entries() AsyncIterable で全 part を逐次返す', async () => {
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

  it('read で存在しない part を要求するとエラー', async () => {
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    try {
      await expect(reader.read('does/not/exist.xml')).rejects.toThrow(/not found/)
    }
    finally {
      await reader.close()
    }
  })

  it('close 後に read を呼ぶとエラー', async () => {
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    await expect(reader.read('ppt/presentation.xml')).rejects.toThrow(/closed/)
  })

  it('close 後に entries を呼ぶとエラー', async () => {
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    expect(() => reader.entries()).toThrow(/closed/)
  })

  it('close は冪等', async () => {
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(DUMMY_PPTX)
    await reader.close()
    await expect(reader.close()).resolves.toBeUndefined()
  })

  it('write は addBuffer / addReadStream の両方で part を追加し、再読込で内容が一致する', async () => {
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

  it('addReadStream パススルーで media-like バイナリを保持する', async () => {
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

  it('read は存在しないパスで reject される', async () => {
    const archive = new YauzlYazlPptxArchive()
    await expect(archive.read(temporaryDirectory('does-not-exist.pptx'))).rejects.toBeInstanceOf(Error)
  })

  it('read は不正な ZIP（空ファイル）で reject される', async () => {
    const badPath = temporaryDirectory('bad.pptx')
    // 空ファイルは ZIP として不正 → yauzl.open が err を返す
    const { writeFileSync } = await import('node:fs')
    writeFileSync(badPath, Buffer.alloc(0))
    const archive = new YauzlYazlPptxArchive()
    await expect(archive.read(badPath)).rejects.toBeInstanceOf(Error)
  })

  it('read はディレクトリ entry をスキップして file entry のみを map に格納する', async () => {
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

  it('finish が指定パスへ ZIP を書き出す（Buffer 一致は仕様外、ZIP magic で確認）', async () => {
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
