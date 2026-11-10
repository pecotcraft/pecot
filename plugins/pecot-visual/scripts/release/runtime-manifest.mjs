// pecotv 永続層（置き場の mcp-dist/）へ入る依存の package.json を組み立てる (#1071)。
// 規則は cli/src/infra/_shared/runtime-install.ts の runtimeInstallPlan() の写し。ずれは runtime-manifest.test.sh が止める。
// catalog: の解決だけは runtimeInstallPlan() と違い、こちらで行う。
// optionalDependencies（playwright）は実 install の対象外なので入れない。
//
//   import: buildRuntimeManifest(pecotvRoot, [workspaceYamlPath]) を渡してオブジェクトを得る。
//   catalog: の解決元は省略時 <pecotvRoot>/../../pnpm-workspace.yaml。catalog: が無ければ読まない。
//
//   直接起動: node runtime-manifest.mjs <pecotv-plugin-root> [pnpm-workspace.yaml]
//   JSON を stdout へ出す。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readDefaultCatalog, resolveCatalog } from './catalog.mjs'
import { isSelfExecuted } from './self-exec.mjs'

// 版を固定する slidev 中核パッケージ（runtime-install.ts の SLIDEV_CORE_PACKAGES と同じ）。
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

export function buildRuntimeManifest(rawPecotvRoot, workspaceYamlPath) {
  const PECOTV_ROOT = path.resolve(rawPecotvRoot)
  const runtimeManifest = readJson(
    path.join(PECOTV_ROOT, 'assets/slidev/runtime/package.json')
  )

  const usesCatalog = [runtimeManifest.dependencies, runtimeManifest.devDependencies]
    .some((field) => Object.values(dependencyMap(field)).some((range) => range.startsWith('catalog:')))
  const catalog = usesCatalog
    ? readDefaultCatalog(readFileSync(workspaceYamlPath ?? path.join(PECOTV_ROOT, '../../pnpm-workspace.yaml'), 'utf8'))
    : {}
  const resolvedDependencies = resolveCatalog(dependencyMap(runtimeManifest.dependencies), catalog)
  const resolvedDevDependencies = resolveCatalog(dependencyMap(runtimeManifest.devDependencies), catalog)

  // 中核パッケージの固定版は、runtime manifest の @slidev/cli の版（runtime-install.ts と同じ読み元）。
  const coreVersion = resolvedDependencies['@slidev/cli']
  if (typeof coreVersion !== 'string' || coreVersion === '') {
    throw new Error('assets/slidev/runtime/package.json dependencies に @slidev/cli の版指定がありません（依存の改名・削除の疑い）')
  }

  const dependencies = {}
  for (const [name, range] of Object.entries(resolvedDependencies)) {
    if (LOCAL_PROTOCOL_PATTERN.test(range)) continue
    dependencies[name] = SLIDEV_CORE_PACKAGES.has(name) ? coreVersion : range
  }

  // pptx 変換の bundle 供給元。manifest では devDependencies だが永続層には要る。
  const domToPptx = resolvedDevDependencies['dom-to-pptx']
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
  const [rawPecotvRoot, workspaceYamlPath] = process.argv.slice(2)
  if (!rawPecotvRoot) {
    console.error('usage: runtime-manifest.mjs <pecotv-plugin-root> [pnpm-workspace.yaml]')
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(buildRuntimeManifest(rawPecotvRoot, workspaceYamlPath), null, 2)}\n`)
}
