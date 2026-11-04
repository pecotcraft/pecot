// 文章規則のパッケージを import するのが infra/text-lint.ts だけであることを確かめる。
// 配布ツリーは、その 1 か所の import 式を同梱した実体へ書き換えるため。

/* eslint-disable security/detect-non-literal-fs-filename -- src ツリーの走査と読み込みのみ */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// tests/unit → cli/src
const SOURCE_ROOT = path.resolve(import.meta.dirname, '..', '..', 'src')
// このテスト自身に当たらないよう、パッケージ名は語を分けて組み立てる
const PACKAGE_NAME = ['@pecot', 'text-rules'].join('/')

function productionSources(): readonly string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:ts|tsx|mts|js)$/u.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => !path.relative(SOURCE_ROOT, file).split(path.sep).includes('tests'))
    .filter(file => !/\.test\.[^.]+$/u.test(file))
    .toSorted((left, right) => left.localeCompare(right))
}

describe('文章規則パッケージの参照', () => {
  it('テストを除く cli/src で、パッケージ名を含むのは infra/text-lint.ts だけ', () => {
    const referencing = productionSources()
      .filter(file => readFileSync(file, 'utf8').includes(PACKAGE_NAME))
      .map(file => path.relative(SOURCE_ROOT, file).split(path.sep).join('/'))
    expect(referencing).toStrictEqual(['infra/text-lint.ts'])
  })
})
