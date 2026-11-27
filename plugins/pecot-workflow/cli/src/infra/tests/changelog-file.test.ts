import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { ChangelogFileNotFoundError, VersionNotFoundError } from '@pecot/workflow-core/domain/changelog.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { extractReleaseNotesFromFile, readChangelogIfExists, readLatestVersionFromFile, resolveChangelogPath } from '../changelog-file.js'

describe('resolveChangelogPath', () => {
  it('ファイル名を明示した場合は、そのファイル名を使う', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名 `CUSTOM-CHANGELOG.md` を指定した場合に、ルートの下のそのファイルのパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    expect(resolveChangelogPath(root, 'CUSTOM-CHANGELOG.md')).toBe(path.join(root, 'CUSTOM-CHANGELOG.md'))
  })

  it('CHANGELOG.md が存在する場合は、そのパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名を指定せず、`CHANGELOG.md` が存在する場合に、そのパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('CHANGELOG.md が存在せず AIST-CHANGELOG.md が存在する場合は、AIST-CHANGELOG.md のパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名を指定せず、`CHANGELOG.md` は存在せず `AIST-CHANGELOG.md` だけが存在する場合は、`AIST-CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('両方が存在する場合は、CHANGELOG.md を優先する', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。`CHANGELOG.md` と `AIST-CHANGELOG.md` の両方が存在する場合に、`CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n', 'AIST-CHANGELOG.md': '# PECOT Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('どちらも存在しない場合は、既定の名前 CHANGELOG.md のパスを返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。どちらのファイルも存在しない場合に、既定の名前の `CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('ファイル名を明示した場合は、CHANGELOG.md が存在しても明示した名前を優先する', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。`CHANGELOG.md` が存在する場合でも、`AIST-CHANGELOG.md` を明示したときは、明示した名前のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root, 'AIST-CHANGELOG.md')).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('空文字列でファイル名を明示した場合は、明示しなかった場合と同じ探し方にする', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名に空文字列を指定した場合に、指定がないものとして扱い、存在する `AIST-CHANGELOG.md` のパスを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': 'x' })
    expect(resolveChangelogPath(root, '')).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('絶対パスで明示した場合は、そのパスをそのまま返す', async () => {
    await explains('CHANGELOG のパスを求める `resolveChangelogPath` のテストです。ファイル名に絶対パス `/abs/CHANGELOG.md` を指定した場合に、ルートと結合せず、そのパスをそのまま返すことを確認します。')
    expect(resolveChangelogPath(makeTemporaryDirectory(), '/abs/CHANGELOG.md')).toBe('/abs/CHANGELOG.md')
  })
})

describe('readChangelogIfExists', () => {
  it('ファイルが存在すれば内容を、存在しなければ undefined を返す', async () => {
    await explains('CHANGELOG を読み込む `readChangelogIfExists` のテストです。ファイルが存在する場合は改行を LF にした内容を返し、存在しない場合は `undefined` を返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '日本語\r\n' })
    expect(readChangelogIfExists(path.join(root, 'CHANGELOG.md'))).toBe('日本語\n')
    expect(readChangelogIfExists(path.join(root, 'none.md'))).toBeUndefined()
  })
})

describe('readLatestVersionFromFile / extractReleaseNotesFromFile', () => {
  it('ファイルから最新のバージョンを取得する', async () => {
    await explains('ファイルから最新のバージョンを取得する `readLatestVersionFromFile` のテストです。`[Unreleased]` の次にある `[0.3.1]` を、最新のバージョンとして返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [Unreleased]\n\n## [0.3.1] - 2026-01-19\n' })
    expect(readLatestVersionFromFile(path.join(root, 'CHANGELOG.md'))).toBe('0.3.1')
  })

  it('ファイルが存在しない場合は、パスを含む ChangelogFileNotFoundError を送出する', async () => {
    await explains('CHANGELOG のファイルが存在しない場合のテストです。どちらも `ChangelogFileNotFoundError` が発生し、前者のメッセージは `CHANGELOG.md not found: <パス>` になることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow(ChangelogFileNotFoundError)
    expect(() => readLatestVersionFromFile(file)).toThrow(`CHANGELOG.md not found: ${file}`)
    expect(() => extractReleaseNotesFromFile(file, '0.6.1')).toThrow(ChangelogFileNotFoundError)
  })

  it('ファイル名が CHANGELOG.md 以外の場合は、メッセージにもそのファイル名を使う', async () => {
    await explains('`AIST-CHANGELOG.md` が存在しない場合のテストです。メッセージが `AIST-CHANGELOG.md not found: <パス>` のように、実際のファイル名を使うことを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'AIST-CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow(`AIST-CHANGELOG.md not found: ${file}`)
  })

  it('バージョンが存在しない場合のメッセージにも、読み込んだファイル名を使う', async () => {
    await explains('バージョンを持たない `AIST-CHANGELOG.md` のテストです。メッセージが `no version found in AIST-CHANGELOG.md` のように、読み込んだファイル名を使うことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': '## [Unreleased]\n' })
    const file = path.join(root, 'AIST-CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow('no version found in AIST-CHANGELOG.md')
    expect(() => extractReleaseNotesFromFile(file, '9.9.9')).toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
  })

  it('バージョンが存在しない場合は、VersionNotFoundError を送出する', async () => {
    await explains('バージョンを持たない CHANGELOG のテストです。`readLatestVersionFromFile` が `VersionNotFoundError` を送出することを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [Unreleased]\n' })
    expect(() => readLatestVersionFromFile(path.join(root, 'CHANGELOG.md'))).toThrow(VersionNotFoundError)
  })

  it('ファイルからリリースノートを抽出する', async () => {
    await explains('ファイルからリリースノートを抽出する `extractReleaseNotesFromFile` のテストです。バージョン `0.6.1` を指定した場合に、その節の本文 `- a` だけを返すことを確認します。')
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [0.6.1]\n\n- a\n\n## [0.6.0]\n- b\n' })
    expect(extractReleaseNotesFromFile(path.join(root, 'CHANGELOG.md'), '0.6.1')).toBe('- a')
  })
})
