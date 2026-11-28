/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { isDirectory, isFile } from '../file-kind.js'

describe('isDirectory / isFile', () => {
  it('ディレクトリとファイルを区別する', async () => {
    await explains('`isDirectory` と `isFile` のテストです。ディレクトリでは前者だけが `true`、ファイルでは後者だけが `true` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('ディレクトリとファイルを置く', () => {
      mkdirSync(path.join(root, 'd'))
      writeFileSync(path.join(root, 'f'), 'x')
    })
    const results = stepSync('ディレクトリとファイルを判定する', () => ({
      directory: [isDirectory(path.join(root, 'd')), isFile(path.join(root, 'd'))],
      file: [isDirectory(path.join(root, 'f')), isFile(path.join(root, 'f'))],
    }))
    stepSync('判定を比べる', () => {
      expect(results.directory).toEqual([true, false])
      expect(results.file).toEqual([false, true])
    })
  })

  it('存在しないパスと、リンク先が存在しないシンボリックリンクは、どちらも false を返す', async () => {
    await explains('`isDirectory` と `isFile` のテストです。存在しないパスと、リンク先が存在しないシンボリックリンクを渡した場合に、どちらの関数も `false` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('リンク先が無いシンボリックリンクを置く', () => {
      symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'))
    })
    const results = stepSync('存在しないパスとリンクを判定する', () => ['missing', 'dangling'].map(name => [isDirectory(path.join(root, name)), isFile(path.join(root, name))]))
    stepSync('判定を比べる', () => {
      expect(results).toEqual([[false, false], [false, false]])
    })
  })

  it('ディレクトリへのシンボリックリンクは、リンク先をたどって判定する', async () => {
    await explains('`isDirectory` のテストです。ディレクトリへのシンボリックリンクを渡した場合に、リンク先をたどって `true` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('ディレクトリとそのシンボリックリンクを置く', () => {
      mkdirSync(path.join(root, 'd'))
      symlinkSync(path.join(root, 'd'), path.join(root, 'link'))
    })
    const isLinkDirectory = stepSync('シンボリックリンクを判定する', () => isDirectory(path.join(root, 'link')))
    stepSync('判定を比べる', () => {
      expect(isLinkDirectory).toBe(true)
    })
  })
})
