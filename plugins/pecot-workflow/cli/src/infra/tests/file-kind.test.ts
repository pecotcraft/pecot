/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { isDirectory, isFile } from '../file-kind.js'

describe('isDirectory / isFile', () => {
  it('ディレクトリとファイルを区別する', async () => {
    await explains('`isDirectory` と `isFile` のテストです。ディレクトリでは前者だけが `true`、ファイルでは後者だけが `true` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'd'))
    writeFileSync(path.join(root, 'f'), 'x')
    expect([isDirectory(path.join(root, 'd')), isFile(path.join(root, 'd'))]).toEqual([true, false])
    expect([isDirectory(path.join(root, 'f')), isFile(path.join(root, 'f'))]).toEqual([false, true])
  })

  it('存在しないパスと、リンク先が存在しないシンボリックリンクは、どちらも false を返す', async () => {
    await explains('`isDirectory` と `isFile` のテストです。存在しないパスと、リンク先が存在しないシンボリックリンクを渡した場合に、どちらの関数も `false` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'))
    for (const name of ['missing', 'dangling']) {
      expect([isDirectory(path.join(root, name)), isFile(path.join(root, name))]).toEqual([false, false])
    }
  })

  it('ディレクトリへのシンボリックリンクは、リンク先をたどって判定する', async () => {
    await explains('`isDirectory` のテストです。ディレクトリへのシンボリックリンクを渡した場合に、リンク先をたどって `true` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'd'))
    symlinkSync(path.join(root, 'd'), path.join(root, 'link'))
    expect(isDirectory(path.join(root, 'link'))).toBe(true)
  })
})
