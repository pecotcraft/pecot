// 依存ルート判定 (infra/_shared/dependency-root.ts) を通すための最小ツリーを作る helper。
//
// 判定は「代表パッケージ (RUNTIME_DEPENDENCY_PROBES) がそのルートの node_modules 配下から
// 引けるか」なので、テストの一時ディレクトリにも同じ形の実体が要る。probe の集合が変わっても
// テスト側が追随するよう、列挙せず実装の定数から作る。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは呼び出し元が mkdtemp で作った一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { RUNTIME_DEPENDENCY_PROBES } from '../../src/infra/_shared/dependency-root.js'

const PACKAGE_JSON_SUFFIX = '/package.json'

/**
probe specifier からパッケージ名を取り出す (`@slidev/cli/package.json` → `@slidev/cli`)。
*/
function probePackageName(specifier: string): string {
  return specifier.endsWith(PACKAGE_JSON_SUFFIX)
    ? specifier.slice(0, -PACKAGE_JSON_SUFFIX.length)
    : specifier
}

/**
`<root>/node_modules/<pkg>` を最小構成 (package.json + index.js) で作る。
*/
export function writeFakePackage(root: string, packageName: string): void {
  const directory = path.join(root, 'node_modules', ...packageName.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }),
    'utf8',
  )
  writeFileSync(path.join(directory, 'index.js'), '', 'utf8')
}

/**
依存ルートとして通る `<root>/node_modules` を作る。

@param extraPackages probe 以外に置きたいパッケージ (解決テスト用)。
*/
export function seedDependencyRoot(root: string, extraPackages: readonly string[] = []): string {
  mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  for (const specifier of RUNTIME_DEPENDENCY_PROBES) writeFakePackage(root, probePackageName(specifier))
  for (const packageName of extraPackages) writeFakePackage(root, packageName)
  return path.join(root, 'node_modules')
}
