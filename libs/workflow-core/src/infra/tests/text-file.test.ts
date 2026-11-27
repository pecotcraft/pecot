/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { readTextFile, TextDecodeError } from '../text-file.js'
import { explains } from '../../../tests/_helpers/explains.js'

describe('readTextFile', () => {
  it('UTF-8 のファイルを読み込むと、内容を文字列として返す', async () => {
    await explains('`readTextFile` のテストです。日本語を含む UTF-8 のファイルの場合に、内容が文字列として返されることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, '日本語')
    expect(readTextFile(file)).toBe('日本語')
  })

  it('改行が CRLF や CR のファイルを読み込むと、改行を LF に統一する', async () => {
    await explains('`readTextFile` のテストです。`\\r\\n` と `\\r` を含むファイルの場合に、改行がすべて `\\n` に統一されることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, 'a\r\nb\rc\nd')
    expect(readTextFile(file)).toBe('a\nb\nc\nd')
  })

  it('BOM 付きのファイルを読み込むと、BOM を取り除かずに返す', async () => {
    await explains('`readTextFile` のテストです。先頭に BOM（`U+FEFF`）がある場合に、BOM を取り除かず、内容にそのまま含めて返すことを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, '\u{FEFF}x')
    expect(readTextFile(file)).toBe('\u{FEFF}x')
  })

  it('BOM のない UTF-8 のファイルを読み込むと、内容をそのまま返す', async () => {
    await explains('`readTextFile` のテストです。BOM のない、改行や絵文字を含む UTF-8 のファイルの場合に、内容が変換されずにそのまま返ることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, 'abc\n日本語 \u{1F600}')
    expect(readTextFile(file)).toBe('abc\n日本語 \u{1F600}')
  })

  it('不正な UTF-8 のバイト列を含むファイルを読み込むと、置換せずに TextDecodeError を発生させる', async () => {
    await explains('`readTextFile` のテストです。UTF-8 として不正なバイトを含むファイルの場合に、`TextDecodeError` が発生し、メッセージにファイルのパスが含まれることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, Buffer.from([0x61, 0xFF, 0x62]))
    expect(() => readTextFile(file)).toThrow(TextDecodeError)
    expect(() => readTextFile(file)).toThrow(`'utf-8' codec can't decode file: ${file}`)
  })

  it('途中で切れた UTF-8 のバイト列を含むファイルを読み込むと、TextDecodeError を発生させる', async () => {
    await explains('`readTextFile` のテストです。マルチバイト文字が途中で終わっているファイルの場合に、`TextDecodeError` が発生することを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, Buffer.from([0xE3, 0x81]))
    expect(() => readTextFile(file)).toThrow(TextDecodeError)
  })

  it('存在しないファイルを読み込むと、Python の FileNotFoundError と同じ文の OsError を発生させる', async () => {
    await explains('`readTextFile` のテストです。存在しないファイルを指定した場合に、`OsError` が発生し、メッセージが `[Errno 2] No such file or directory` の形式になることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'missing.txt')
    expect(() => readTextFile(file)).toThrow(OsError)
    expect(() => readTextFile(file)).toThrow(`[Errno 2] No such file or directory: '${file}'`)
  })

  it('ディレクトリを読み込むと、Python の IsADirectoryError と同じ文の OsError を発生させる', async () => {
    await explains('`readTextFile` のテストです。ディレクトリを指定した場合に、メッセージが `[Errno 21] Is a directory` の形式の `OsError` が発生することを確認します。')
    const directory = path.join(makeTemporaryDirectory(), 'dir')
    mkdirSync(directory)
    expect(() => readTextFile(directory)).toThrow(`[Errno 21] Is a directory: '${directory}'`)
  })
})
