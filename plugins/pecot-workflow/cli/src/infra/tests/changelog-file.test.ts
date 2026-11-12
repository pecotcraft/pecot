import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ChangelogFileNotFoundError, VersionNotFoundError } from '../../domain/changelog.js'
import { makeTemporaryDirectory, writeTree } from '../../tests/_helpers/temporary.js'
import { extractReleaseNotesFromFile, readChangelogIfExists, readLatestVersionFromFile, resolveChangelogPath } from '../changelog-file.js'

describe('resolveChangelogPath', () => {
  it('明示指定のファイル名を使う', () => {
    const root = makeTemporaryDirectory()
    expect(resolveChangelogPath(root, 'CUSTOM-CHANGELOG.md')).toBe(path.join(root, 'CUSTOM-CHANGELOG.md'))
  })

  it('CHANGELOG.md があればそれを返す', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('CHANGELOG.md が無く AIST-CHANGELOG.md があればそれを返す', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('両方あれば CHANGELOG.md を優先する', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n', 'AIST-CHANGELOG.md': '# PECOT Changelog\n' })
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('どちらも無ければ既定の名前を返す', () => {
    const root = makeTemporaryDirectory()
    expect(resolveChangelogPath(root)).toBe(path.join(root, 'CHANGELOG.md'))
  })

  it('明示指定はフォールバックに優先する', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '# Changelog\n' })
    expect(resolveChangelogPath(root, 'AIST-CHANGELOG.md')).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('空文字列の明示指定はフォールバックに回る（Python の if changelog_file と同じ）', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': 'x' })
    expect(resolveChangelogPath(root, '')).toBe(path.join(root, 'AIST-CHANGELOG.md'))
  })

  it('絶対パスの明示指定はそのまま返す（pathlib の / と同じ）', () => {
    expect(resolveChangelogPath(makeTemporaryDirectory(), '/abs/CHANGELOG.md')).toBe('/abs/CHANGELOG.md')
  })
})

describe('readChangelogIfExists', () => {
  it('あれば内容、無ければ undefined', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '日本語\r\n' })
    expect(readChangelogIfExists(path.join(root, 'CHANGELOG.md'))).toBe('日本語\n')
    expect(readChangelogIfExists(path.join(root, 'none.md'))).toBeUndefined()
  })
})

describe('readLatestVersionFromFile / extractReleaseNotesFromFile', () => {
  it('ファイルから最新バージョンを取る', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [Unreleased]\n\n## [0.3.1] - 2026-01-19\n' })
    expect(readLatestVersionFromFile(path.join(root, 'CHANGELOG.md'))).toBe('0.3.1')
  })

  it('ファイルが無ければ ChangelogFileNotFoundError（パスを文に含む）', () => {
    const file = path.join(makeTemporaryDirectory(), 'CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow(ChangelogFileNotFoundError)
    expect(() => readLatestVersionFromFile(file)).toThrow(`CHANGELOG.md not found: ${file}`)
    expect(() => extractReleaseNotesFromFile(file, '0.6.1')).toThrow(ChangelogFileNotFoundError)
  })

  it('ファイル名が違うときは、文もそのファイル名を使う', () => {
    const file = path.join(makeTemporaryDirectory(), 'AIST-CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow(`AIST-CHANGELOG.md not found: ${file}`)
  })

  it('バージョンが無いときの文も、読んだファイル名を使う', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'AIST-CHANGELOG.md': '## [Unreleased]\n' })
    const file = path.join(root, 'AIST-CHANGELOG.md')
    expect(() => readLatestVersionFromFile(file)).toThrow('no version found in AIST-CHANGELOG.md')
    expect(() => extractReleaseNotesFromFile(file, '9.9.9')).toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
  })

  it('バージョンが無ければ VersionNotFoundError', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [Unreleased]\n' })
    expect(() => readLatestVersionFromFile(path.join(root, 'CHANGELOG.md'))).toThrow(VersionNotFoundError)
  })

  it('ファイルからリリースノートを抽出する', () => {
    const root = makeTemporaryDirectory()
    writeTree(root, { 'CHANGELOG.md': '## [0.6.1]\n\n- a\n\n## [0.6.0]\n- b\n' })
    expect(extractReleaseNotesFromFile(path.join(root, 'CHANGELOG.md'), '0.6.1')).toBe('- a')
  })
})
