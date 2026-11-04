// テーマの取得元に関わる関数。create と sync（移行）が使う。

import path from 'node:path'

import type { ThemeSpec } from '../../domain/slidev-theme/theme-spec.js'

/**
`file:` の指定を絶対パスにする。git の指定はそのまま。
*/
export function absoluteSpec(spec: Readonly<ThemeSpec>, currentDirectory: string): ThemeSpec {
  return spec.kind === 'file' ? { kind: 'file', path: path.resolve(currentDirectory, spec.path) } : spec
}

/**
talk-dir の package.json に書く spec。`file:` は talk-dir からの相対にする。
*/
export function packageSpec(theme: string, spec: Readonly<ThemeSpec>, projectDirectory: string): string {
  if (spec.kind !== 'file') return theme
  const relative = path.relative(projectDirectory, spec.path).split(path.sep).join('/')
  return `file:${relative}`
}
