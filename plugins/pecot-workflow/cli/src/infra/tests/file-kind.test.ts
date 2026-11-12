/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { isDirectory, isFile } from '../file-kind.js'

describe('isDirectory / isFile', () => {
  it('ディレクトリとファイルを区別する', () => {
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'd'))
    writeFileSync(path.join(root, 'f'), 'x')
    expect([isDirectory(path.join(root, 'd')), isFile(path.join(root, 'd'))]).toEqual([true, false])
    expect([isDirectory(path.join(root, 'f')), isFile(path.join(root, 'f'))]).toEqual([false, true])
  })

  it('無いパスと指す先が無いシンボリックリンクは、どちらも false', () => {
    const root = makeTemporaryDirectory()
    symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'))
    for (const name of ['missing', 'dangling']) {
      expect([isDirectory(path.join(root, name)), isFile(path.join(root, name))]).toEqual([false, false])
    }
  })

  it('シンボリックリンクは辿る', () => {
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'd'))
    symlinkSync(path.join(root, 'd'), path.join(root, 'link'))
    expect(isDirectory(path.join(root, 'link'))).toBe(true)
  })
})
