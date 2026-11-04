// talkPackageJsonSource の検証。name・version・private・type と、テーマ 1 つだけの dependencies を書くことを固定する。

import { describe, expect, it } from 'vitest'

import { talkPackageJsonSource } from '../package-json.js'

describe('talkPackageJsonSource', () => {
  it('name・version・private・type と、テーマ 1 つだけの dependencies を書く', () => {
    const result = talkPackageJsonSource({
      name: 'my-talk',
      themeName: 'slidev-theme-sample',
      themeSpec: 'git+https://example.com/org/theme.git#v1.2.0',
    })
    expect(result).toBe(`${JSON.stringify({
      name: 'my-talk',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { 'slidev-theme-sample': 'git+https://example.com/org/theme.git#v1.2.0' },
    }, undefined, 2)}\n`)
  })

  it('scope 付きのテーマ名も dependencies のキーにそのまま使う', () => {
    const result = talkPackageJsonSource({ name: 't', themeName: '@scope/slidev-theme-x', themeSpec: 'file:../theme' })
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(result) as { dependencies: Record<string, string> }
    expect(parsed.dependencies).toStrictEqual({ '@scope/slidev-theme-x': 'file:../theme' })
  })
})
