import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { makeTemporaryDirectory, writeTree } from '../../../tests/_helpers/temporary.js'
import { readChangelogIfExists, resolveChangelogPath } from '../changelog-file.js'

describe('resolveChangelogPath', () => {
  it('ファイル名を明示した場合は、そのファイル名を使う', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名 `CUSTOM-CHANGELOG.md` を指定した場合に、ルートの下のそのファイルのパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    const resolved = stepSync('ファイル名を指定してパスを求める', () => resolveChangelogPath(root, 'CUSTOM-CHANGELOG.md'))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'CUSTOM-CHANGELOG.md'))
    })
  })

  it('CHANGELOG.md が存在する場合は、そのパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名を指定せず、`CHANGELOG.md` が存在する場合に、そのパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('CHANGELOG.md を置く', () => {
      writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    })
    const resolved = stepSync('パスを求める', () => resolveChangelogPath(root))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'CHANGELOG.md'))
    })
  })

  it('CHANGELOG.md が存在せず AIST-CHANGELOG.md が存在する場合は、AIST-CHANGELOG.md のパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名を指定せず、`CHANGELOG.md` は存在せず `AIST-CHANGELOG.md` だけが存在する場合は、`AIST-CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('AIST-CHANGELOG.md を置く', () => {
      writeTree(root, { 'AIST-CHANGELOG.md': '# Changelog\n' })
    })
    const resolved = stepSync('パスを求める', () => resolveChangelogPath(root))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'AIST-CHANGELOG.md'))
    })
  })

  it('両方が存在する場合は、CHANGELOG.md を優先する', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。`CHANGELOG.md` と `AIST-CHANGELOG.md` の両方が存在する場合に、`CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('2 つのファイルを置く', () => {
      writeTree(root, { 'CHANGELOG.md': '# Changelog\n', 'AIST-CHANGELOG.md': '# PECOT Changelog\n' })
    })
    const resolved = stepSync('パスを求める', () => resolveChangelogPath(root))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'CHANGELOG.md'))
    })
  })

  it('どちらも存在しない場合は、既定の名前 CHANGELOG.md のパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。どちらのファイルも存在しない場合に、既定の名前の `CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    const resolved = stepSync('パスを求める', () => resolveChangelogPath(root))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'CHANGELOG.md'))
    })
  })

  it('ファイル名を明示した場合は、CHANGELOG.md が存在しても明示した名前を優先する', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。`CHANGELOG.md` が存在する場合でも、`AIST-CHANGELOG.md` を明示したときは、明示した名前のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('CHANGELOG.md を置く', () => {
      writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    })
    const resolved = stepSync('ファイル名を指定してパスを求める', () => resolveChangelogPath(root, 'AIST-CHANGELOG.md'))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'AIST-CHANGELOG.md'))
    })
  })

  it('空文字列でファイル名を明示した場合は、明示しなかった場合と同じ探し方にする', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名に空文字列を指定した場合に、指定がないものとして扱い、存在する `AIST-CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('AIST-CHANGELOG.md を置く', () => {
      writeTree(root, { 'AIST-CHANGELOG.md': 'x' })
    })
    const resolved = stepSync('空文字列を指定してパスを求める', () => resolveChangelogPath(root, ''))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe(path.join(root, 'AIST-CHANGELOG.md'))
    })
  })

  it('絶対パスで明示した場合は、そのパスをそのまま返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名に絶対パス `/abs/CHANGELOG.md` を指定した場合に、ルートと結合せず、そのパスをそのまま返すことを確認します。')
    const resolved = stepSync('絶対パスを指定してパスを求める', () => resolveChangelogPath(makeTemporaryDirectory(), '/abs/CHANGELOG.md'))
    stepSync('パスを比べる', () => {
      expect(resolved).toBe('/abs/CHANGELOG.md')
    })
  })
})

describe('readChangelogIfExists', () => {
  it('ファイルが存在すれば内容を、存在しなければ undefined を返す', async () => {
    await explains('CHANGELOG を読み込む `readChangelogIfExists` のテストです。ファイルが存在する場合は改行を LF にした内容を返し、存在しない場合は `undefined` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    stepSync('CRLF のファイルを置く', () => {
      writeTree(root, { 'CHANGELOG.md': '日本語\r\n' })
    })
    const existing = stepSync('存在するファイルを読む', () => readChangelogIfExists(path.join(root, 'CHANGELOG.md')))
    const missing = stepSync('存在しないファイルを読む', () => readChangelogIfExists(path.join(root, 'none.md')))
    stepSync('読んだ結果を比べる', () => {
      expect(existing).toBe('日本語\n')
      expect(missing).toBeUndefined()
    })
  })
})
