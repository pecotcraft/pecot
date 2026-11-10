// 本体の assets/slidev が持つ eslint を子プロセスで起動する EslintRunner 実装。
//
// standalone talk-dir には lint 資材を同梱しない方針のため、eslint 本体と flat config は本体の `assets/slidev` から借りる。
// テーマの宣言の解釈結果（`slide theme` の lint）は、環境変数 PECOTV_DECK_LINT に JSON で渡す。
// PostToolUse hook (`hooks/lib/post-tool-use/eslint-check.sh`) と同じ供給機構。
//
// cwd は必ず talk-dir にする。
// flat config の files / ignores パターンは、`--config` 指定時でも cwd 基準で解決される。
// そのため chdir を怠ると、1 ファイルも lint せず exit 0 になる。

import { createRequire } from 'node:module'
import path from 'node:path'

import { isRecord } from '../../domain/_shared/json.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { doesRangeAllowMajor } from '../../domain/_shared/version-range.js'
import type { EslintRunArguments, EslintRunner } from '../../domain/slidev-project/lint.js'
import { SlideLintRuntimeError } from '../../domain/slidev-project/lint.js'
import { spawnPromise } from '../_shared/process.js'

const ESLINT_TIMEOUT_MS = 60_000

/**
デッキ用の flat config。`eslint.config.*` の名前にしないのは、ESLint 10 が対象ファイルに最も近い
`eslint.config.*` を上方探索で使うため。`--config` で渡すので探索には拾われない。
*/

/**
lint 対象。`pages/_references/*.yaml` の validate-references は対象外。
*/
const LINT_TARGETS: readonly string[] = ['pages/**/*.md', 'slides.md']

export type EslintBinResolver = (assetsDirectory: string) => string

/**
`assets/slidev` が使う eslint bin (`bin/eslint.js`) の絶対パスを解決する。

eslint の `exports` は `./bin/eslint.js` を公開していないため直接 resolve できない。
`assets/slidev/package.json` 基準の `createRequire` で `eslint/package.json` を引く。
`bin.eslint` は package root からの相対で解決する（`infra/slidev-to-pptx/runner.ts` の `resolveSlidevBin` と同じ流儀）。

assert の目的は、「`assets/slidev` が想定していない eslint で lint 結果が変わる」ことの防止。
判定材料は、解決した eslint のメジャー版が `assets/slidev/package.json` の `devDependencies.eslint` の range に収まるか。
解決先パスでは見ない。単体配布形態では eslint がプラグインルートの兄弟（`_npx/<hash>/node_modules/eslint`）に置かれ、
パス前置判定では必ず失敗するため。

`devDependencies.eslint` が無ければ throw する（fail-closed）。
そのまま通すと「どのメジャーでもよい」ことになるため。
*/
export function resolveEslintBin(assetsDirectory: string): string {
  const assetsRoot = path.resolve(assetsDirectory)
  const requireFromAssets = createRequire(path.join(assetsRoot, 'package.json'))

  let packageJsonPath: string
  try {
    packageJsonPath = requireFromAssets.resolve('eslint/package.json')
  }
  catch (error: unknown) {
    throw new SlideLintRuntimeError(
      `cannot resolve eslint from ${assetsRoot}`
      + ` (the core dependencies may not be installed): ${formatError(error)}`,
      'eslint-not-launched',
    )
  }

  // eslint-disable-next-line no-restricted-syntax -- require 戻り値 (any) の narrowing
  const packageJson = requireFromAssets(packageJsonPath) as Readonly<{
    bin?: Readonly<Record<string, string>> | string
    version?: string
  }>
  const binEntry = packageJson.bin
  /* c8 ignore next 3 -- eslint の package.json は常に `bin.eslint` を持つ。他形式は防御網 */
  const relativeBin = typeof binEntry === 'string'
    ? binEntry
    : binEntry?.['eslint'] ?? 'bin/eslint.js'
  const binPath = path.resolve(path.dirname(packageJsonPath), relativeBin)

  assertEslintMatchesAssets({
    assetsRoot,
    binPath,
    resolvedVersion: packageJson.version ?? '',
    wantRange: assetsEslintRange(requireFromAssets, assetsRoot),
  })
  return binPath
}

/**
`assets/slidev/package.json` が宣言する eslint の range。宣言が無ければ空文字。

package.json 自体が読めない（欠落・不正 JSON）ときは、上流の eslint 解決と同じく
`SlideLintRuntimeError` へ畳む。生の例外を伝播させると reason 付きの失敗にならない。
*/
function assetsEslintRange(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Require は mutable 型
  requireFromAssets: NodeJS.Require,
  assetsRoot: string,
): string {
  let manifest: unknown
  try {
    manifest = requireFromAssets(path.join(assetsRoot, 'package.json'))
  }
  catch (error: unknown) {
    throw new SlideLintRuntimeError(
      `cannot read package.json in ${assetsRoot}`
      + ` (aborting because the eslint to lint with cannot be decided): ${formatError(error)}`,
      'eslint-not-launched',
    )
  }
  /* c8 ignore next -- object 以外の package.json は、手前の require.resolve が node の package 検証で弾くため到達不能 */
  const devDependencies = isRecord(manifest) ? manifest['devDependencies'] : undefined
  const range = isRecord(devDependencies) ? devDependencies['eslint'] : undefined
  return typeof range === 'string' ? range : ''
}

function assertEslintMatchesAssets(
  context: Readonly<{
    assetsRoot: string
    binPath: string
    resolvedVersion: string
    wantRange: string
  }>,
): void {
  if (context.wantRange === '') {
    throw new SlideLintRuntimeError(
      `package.json in ${context.assetsRoot} does not declare devDependencies.eslint;`
      + ' aborting because the eslint to lint with cannot be decided',
      'eslint-not-launched',
    )
  }

  /* c8 ignore next -- split の先頭要素は常に文字列で、空文字への代替の右辺は到達不能 */
  const majorText = context.resolvedVersion.split('.', 1)[0] ?? ''
  const resolvedMajor = majorText === '' ? NaN : Number(majorText)
  if (Number.isNaN(resolvedMajor) || !doesRangeAllowMajor(context.wantRange, resolvedMajor)) {
    throw new SlideLintRuntimeError(
      `eslint bin ${context.binPath} is version ${context.resolvedVersion},`
      + ` a different major from ${context.wantRange} required by assets/slidev;`
      + ' aborting because lint results are not guaranteed with an eslint other than the one the core expects',
      'eslint-not-launched',
    )
  }
}

export class ChildProcessEslintRunner implements EslintRunner {
  private readonly resolveBin: EslintBinResolver

  public constructor(resolver: EslintBinResolver = resolveEslintBin) {
    this.resolveBin = resolver
  }

  /**
  `node <eslint-bin>` を、talk-dir を cwd にして起動する。
  引数は `--no-fix --config <本体の deck-lint.env.config.js> --format json` の 3 組。
  環境変数 `PECOTV_DECK_LINT` に、`slide theme` が解釈した lint の 4 項目を JSON で渡す。
  さらに `--no-error-on-unmatched-pattern` と、対象 glob の `pages/**\/*.md slides.md` を渡す。

  - `--no-fix`: 対象ルールは全て `meta.fixable` 未宣言で、`--fix` は no-op。
  - `--no-error-on-unmatched-pattern`: `pages/*.md` が 0 件のとき eslint は exit 2 で異常終了する。
    違反と紛れないよう、フラグで抑止する。
  - glob は `shell: false` 起動のためシェル展開されず、eslint 自身の globSearch が解釈する。
  */
  async run(arguments_: Readonly<EslintRunArguments>): Promise<SpawnResult> {
    const eslintBin = this.resolveBin(arguments_.assetsDirectory)
    const spawnArguments: string[] = [
      eslintBin,
      '--no-fix',
      '--config',
      arguments_.deckLintConfig,
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      ...LINT_TARGETS,
    ]
    return spawnPromise(process.execPath, spawnArguments, {
      cwd: arguments_.talkDirectory,
      // deck lint の設定は、宣言を読まずこの JSON を受ける。create / sync の自動 lint も同じ設定で動く。
      env: { ...process.env, PECOTV_DECK_LINT: JSON.stringify(arguments_.lint) },
      timeoutMs: ESLINT_TIMEOUT_MS,
    })
  }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */
