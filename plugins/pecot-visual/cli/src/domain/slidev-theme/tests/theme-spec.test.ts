import { describe, expect, it } from 'vitest'

import { parseThemeSpec, ThemeSpecError } from '../theme-spec.js'

const OK_CASES: readonly (readonly [string, string, unknown])[] = [
  ['git+https とタグ', 'git+https://git.example.com/acme/theme.git#1.2.3', { kind: 'git', url: 'https://git.example.com/acme/theme.git', tag: '1.2.3' }],
  ['先頭に v を付けたタグ', 'git+https://git.example.com/acme/theme.git#v1.2.3', { kind: 'git', url: 'https://git.example.com/acme/theme.git', tag: 'v1.2.3' }],
  ['git+ssh', 'git+ssh://git@git.example.com/acme/theme.git#2.0.0', { kind: 'git', url: 'ssh://git@git.example.com/acme/theme.git', tag: '2.0.0' }],
  ['プレリリース', 'git+https://git.example.com/acme/theme.git#1.0.0-rc.1', { kind: 'git', url: 'https://git.example.com/acme/theme.git', tag: '1.0.0-rc.1' }],
  ['ビルドメタデータ', 'git+https://git.example.com/acme/theme.git#1.0.0+build.5', { kind: 'git', url: 'https://git.example.com/acme/theme.git', tag: '1.0.0+build.5' }],
  ['プレリリースとビルドメタデータ', 'git+https://git.example.com/acme/theme.git#v1.0.0-alpha.1+exp.sha', { kind: 'git', url: 'https://git.example.com/acme/theme.git', tag: 'v1.0.0-alpha.1+exp.sha' }],
  ['git+file（ローカルの bare リポジトリ）', 'git+file:///work/theme.git#v1.0.0', { kind: 'git', url: 'file:///work/theme.git', tag: 'v1.0.0' }],
  ['file の相対パス', 'file:../theme', { kind: 'file', path: '../theme' }],
  ['file の絶対パス', 'file:/work/theme', { kind: 'file', path: '/work/theme' }],
]

const REJECT_CASES: readonly (readonly [string, string, string])[] = [
  ['タグ無し', 'git+https://git.example.com/acme/theme.git', 'tag-required'],
  ['空のタグ', 'git+https://git.example.com/acme/theme.git#', 'tag-required'],
  ['ブランチ名', 'git+https://git.example.com/acme/theme.git#main', 'tag-format'],
  ['短縮 SHA', 'git+https://git.example.com/acme/theme.git#a1b2c3d', 'tag-format'],
  ['40 桁 SHA', 'git+https://git.example.com/acme/theme.git#0123456789abcdef0123456789abcdef01234567', 'tag-format'],
  ['先行ゼロ', 'git+https://git.example.com/acme/theme.git#01.2.3', 'tag-format'],
  ['要素が足りない版', 'git+https://git.example.com/acme/theme.git#1.2', 'tag-format'],
  ['semver 範囲', 'git+https://git.example.com/acme/theme.git#semver:^1.0.0', 'semver-range'],
  ['プレリリースが空', 'git+https://git.example.com/acme/theme.git#1.0.0-', 'tag-format'],
  ['ビルドメタデータが空', 'git+https://git.example.com/acme/theme.git#1.0.0+', 'tag-format'],
  ['file の中身が空', 'file:', 'unsupported-spec'],
]

function thrownBy(text: string): unknown {
  try {
    parseThemeSpec(text)
  }
  catch (error: unknown) {
    return error
  }
  return undefined
}

describe('parseThemeSpec', () => {
  it.each(OK_CASES)('%s を解釈する', (_label, text, expected) => {
    expect(parseThemeSpec(text)).toEqual(expected)
  })

  it.each(REJECT_CASES)('%s を拒む', (_label, text, reason) => {
    expect(thrownBy(text)).toMatchObject({ name: 'ThemeSpecError', reason })
  })

  it('タグの書式でないものは文言を統一する', () => {
    for (const tag of ['main', 'a1b2c3d', '0123456789abcdef0123456789abcdef01234567']) {
      expect(() => parseThemeSpec(`git+https://git.example.com/acme/theme.git#${tag}`)).toThrow('タグの書式でない')
    }
  })

  it('git でも file でもない指定を拒む', () => {
    expect(() => parseThemeSpec('^1.0.0')).toThrow(ThemeSpecError)
    expect(() => parseThemeSpec('https://git.example.com/acme/theme.git#1.0.0')).toThrow(ThemeSpecError)
  })
})
