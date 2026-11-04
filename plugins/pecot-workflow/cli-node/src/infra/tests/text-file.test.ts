/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { readTextFile } from '../text-file.js'

describe('readTextFile', () => {
  it('UTF-8 で読む', () => {
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, '日本語')
    expect(readTextFile(file)).toBe('日本語')
  })

  it('改行は \\n に揃える（universal newlines）', () => {
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, 'a\r\nb\rc\nd')
    expect(readTextFile(file)).toBe('a\nb\nc\nd')
  })

  it('BOM は落とさない（Python の utf-8 と同じ）', () => {
    const file = path.join(makeTemporaryDirectory(), 'a.txt')
    writeFileSync(file, '\u{FEFF}x')
    expect(readTextFile(file)).toBe('\u{FEFF}x')
  })

  it('無いファイルは Python の FileNotFoundError と同じ文の OsError', () => {
    const file = path.join(makeTemporaryDirectory(), 'missing.txt')
    expect(() => readTextFile(file)).toThrow(OsError)
    expect(() => readTextFile(file)).toThrow(`[Errno 2] No such file or directory: '${file}'`)
  })

  it('ディレクトリは Python の IsADirectoryError と同じ文の OsError', () => {
    const directory = path.join(makeTemporaryDirectory(), 'dir')
    mkdirSync(directory)
    expect(() => readTextFile(directory)).toThrow(`[Errno 21] Is a directory: '${directory}'`)
  })
})
