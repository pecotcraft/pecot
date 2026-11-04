// pecotv 永続層（置き場の mcp-dist/） へ入る依存の package.json を組み立てる (#1071)。
//
// 永続層に何を入れるかの元データは、cli/src/infra/_shared/runtime-install.ts の runtimeInstallPlan()。
// 監査は、cli のビルド成果物へ依存せず同じ依存集合を得たい。
// そのため、同じ規則をここに写す。
// 写し間違いは、scripts/release/tests/runtime-manifest.test.sh が止める。
// このテストは、cli/dist の runtimeInstallPlan() と比べて検出する。
//
// 実 install は、`npm install --no-package-lock <specifier...>` で specifier の列を取る。
// 監査は、`npm install --package-lock-only` で package.json の dependencies から解決する。
// 同じ集合を map として組み直すのが、このモジュールの役目。
// optionalDependencies（playwright）は実 install の対象外なので、ここにも入れない。
// 監査範囲を、実 install に一致させるためだ。
// 依存の元データは、本体が持つ実行時依存の manifest（assets/slidev/runtime/package.json）。
//
//   import: buildRuntimeManifest(pecotvRoot) -> オブジェクト
//
//   直接起動: node runtime-manifest.mjs <pecotv-plugin-root> -> JSON を stdout

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isSelfExecuted } from './self-exec.mjs'

// 永続層でバージョンを固定する slidev 中核パッケージ（runtime-install.ts の SLIDEV_CORE_PACKAGES）。
// 互いを完全一致のバージョンで要求する。
// そのため、キャレット指定のまま渡すと、nested に別のバージョンが入る。
const SLIDEV_CORE_PACKAGES = new Set(['@slidev/cli', '@slidev/client', '@slidev/parser', '@slidev/types'])

// ローカル参照の依存。パッケージとして解決できないため install と監査のどちらの対象にもしない。
const LOCAL_PROTOCOL_PATTERN = /^(?:workspace|link|file|portal):/

// テーマの置き場が patch を当てるために使う（runtime-install.ts の PATCH_PACKAGE_RANGE の写し）。
const PATCH_PACKAGE_RANGE = '8.0.1'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// package.json の依存フィールドを 名前 -> range へ絞り込む（値が文字列でないものは捨てる）。
const dependencyMap = (value) =>
  isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).filter(([, range]) => typeof range === 'string'))
    : {}

export function buildRuntimeManifest(rawPecotvRoot) {
  const PECOTV_ROOT = path.resolve(rawPecotvRoot)
  const runtimeManifest = readJson(
    path.join(PECOTV_ROOT, 'assets/slidev/runtime/package.json')
  )
  const cliManifest = readJson(path.join(PECOTV_ROOT, 'cli/package.json'))

  // 中核パッケージの固定バージョンは、cli/package.json の @slidev/parser の pin から読む。
  // runtime-install.ts は同じ値を SLIDEV_CORE_VERSION として持つ。
  // cli の unit test が、両者の同値を固定している。
  const coreVersion = dependencyMap(cliManifest.dependencies)['@slidev/parser']
  if (typeof coreVersion !== 'string' || coreVersion === '') {
    throw new Error('cli/package.json dependencies に @slidev/parser の版指定がありません（依存の改名・削除の疑い）')
  }

  const dependencies = {}
  for (const [name, range] of Object.entries(dependencyMap(runtimeManifest.dependencies))) {
    if (LOCAL_PROTOCOL_PATTERN.test(range)) continue
    dependencies[name] = SLIDEV_CORE_PACKAGES.has(name) ? coreVersion : range
  }

  // pptx 変換の bundle 供給元。manifest では devDependencies だが永続層には要る。
  const domToPptx = dependencyMap(runtimeManifest.devDependencies)['dom-to-pptx']
  if (domToPptx !== undefined) dependencies['dom-to-pptx'] = domToPptx

  dependencies['@slidev/parser'] = coreVersion
  dependencies['patch-package'] = PATCH_PACKAGE_RANGE

  // overrides は manifest の写し。解決の pin を落とすと永続層だけが別の推移依存を掴み、
  // 監査対象と実 install がずれる。
  const overrides = runtimeManifest.overrides

  return {
    name: 'pecotv-runtime',
    version: '0.0.0',
    private: true,
    dependencies,
    overrides: isPlainObject(overrides) ? overrides : {}
  }
}

if (isSelfExecuted(import.meta.url)) {
  const [rawPecotvRoot] = process.argv.slice(2)
  if (!rawPecotvRoot) {
    console.error('usage: runtime-manifest.mjs <pecotv-plugin-root>')
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(buildRuntimeManifest(rawPecotvRoot), null, 2)}\n`)
}
