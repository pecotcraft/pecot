// fixture テーマ (tests/fixtures/themes) を一時ディレクトリへ用意し、`file:` の指定を返す helper。
/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// tests/_helpers → tests
export const FIXTURE_THEMES = path.resolve(import.meta.dirname, '..', 'fixtures', 'themes')

export type FixtureTheme = 'with-declaration' | 'without-declaration'

export interface CopiedTheme {
  readonly directory: string
  // `slide create --theme` と package.json に渡す `file:` の指定
  readonly spec: string
}

/**
fixture テーマを destination へ写し、`file:` の指定を返す。
`dependencies` は外す。file: の取得は install しないため、node_modules の無い写しでは取得できない。
layout の vue は create・theme・lint の宣言の読み取りだけが見る。dev・build は通らない。
*/
export function copyFixtureTheme(fixture: FixtureTheme, destination: string): CopiedTheme {
  cpSync(path.join(FIXTURE_THEMES, fixture), destination, { recursive: true })
  const manifestPath = path.join(destination, 'package.json')
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  Reflect.deleteProperty(manifest, 'dependencies')
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2))
  return { directory: destination, spec: `file:${destination}` }
}
