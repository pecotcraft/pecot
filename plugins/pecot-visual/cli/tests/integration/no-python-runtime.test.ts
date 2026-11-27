// Phase 4 (#391) acceptance (a)(b) 機械検証 + T321 (Python 未インストール風環境での 0 終了)。
// repo 全体から `PECOTV_RUNTIME` 参照ゼロ件を assert する。
// `plugins/pecot-visual/` 配下から `uv run` / `pyproject` / `engines.python` 参照ゼロ件も assert する。
// Python 実装ツリーの完全削除も assert する。
//
// 走査は git grep で git 追跡ファイルのみを対象にする（#703）。リポジトリの検証が
// 意図なので、追跡外のローカル状態（node_modules・.pecot・dangling symlink 等）には
// 依存しない。
// `plugins/pecot-workflow/` (pecot-workflow プラグイン本体) は Python ベース実装で残る。
// ただし `PECOTV_RUNTIME` 参照を持たないため、(a) の走査対象に含めて問題ない。
// untracked の新規ファイルは走査対象外。pre-push 時点では痕跡は commit 済み＝tracked に
// なる運用前提で成立する。

import { spawnSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { attachOutput } from '../_helpers/attach.js'
import { explains } from '../_helpers/explains.js'

const HERE = import.meta.dirname
const CLI_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const CLI_TS_DIST = path.resolve(PLUGIN_ROOT, 'cli', 'dist', 'main.js')
const NODE_MODULES_DIR = path.resolve(REPO_ROOT, 'node_modules')

// 走査から除外する pathspec。CHANGELOG は撤去の経緯記録、自テストはパターン定義
// そのものを含むため、いずれも痕跡ではない。
const EXCLUDE_PATHSPECS: readonly string[] = [
  ':!*CHANGELOG.md',
  ':!plugins/pecot-visual/cli/tests/integration/no-python-runtime.test.ts',
]

function grepHits(pattern: string, options: { readonly scope?: string, readonly extended?: boolean } = {}): readonly string[] {
  const flags = options.extended === true ? '-InE' : '-In'
  // scope 未指定時は除外 pathspec のみ渡し、全追跡ファイルが対象になる
  const scope = options.scope === undefined ? [] : [options.scope]
  const result = spawnSync('git', ['grep', flags, '-e', pattern, '--', ...scope, ...EXCLUDE_PATHSPECS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  attachOutput(`git grep ${flags} -e ${pattern}`, result.status ?? undefined, result.stdout, result.stderr)
  // git grep exit: 0 = ヒットあり / 1 = ヒットなし / その他 = エラー
  if (result.status === 1) return []
  if (result.status === 0) {
    return result.stdout.split('\n').filter(line => line.length > 0)
  }
  throw new Error(`git grep がエラー終了: status=${String(result.status)} stderr=${result.stderr} error=${String(result.error?.message)}`)
}

beforeAll(() => {
  if (!existsSync(CLI_TS_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_TS_DIST}\n先に plugins/pecot-visual/scripts/ci/run-tests.sh の build ステップを実行してください`)
  }
  if (!existsSync(NODE_MODULES_DIR)) {
    throw new Error(`node_modules が存在しません: ${NODE_MODULES_DIR}\n先に repo root で pnpm install --frozen-lockfile を実行してください`)
  }
})

describe('Phase 4 acceptance: Python ランタイム痕跡ゼロ件', () => {
  it('リポジトリ全体に、旧ランタイムの切替変数 PECOTV_RUNTIME への参照が存在しない', async () => {
    // 旧 Python ランタイムの切替変数 PECOTV_RUNTIME が対象。実行用ミラーを指す PECOTV_RUNTIME_DIR (#1230) は別物
    await explains('Python ランタイムを撤去したことのテストです。Git で追跡するファイル全体を検索した場合に、`PECOTV_RUNTIME` への参照が 0 件であることを確認します（`PECOTV_RUNTIME_DIR` は別の変数なので対象外です）。')
    const hits = grepHits(String.raw`PECOTV_RUNTIME\b`, { extended: true })
    expect(hits).toEqual([])
  })

  it('plugins/pecot-visual 配下に、uv run・pyproject・engines.python への参照が存在しない', async () => {
    await explains('Python ランタイムを撤去したことのテストです。`plugins/pecot-visual` 配下の追跡ファイルを検索した場合に、`uv run`・`pyproject`・`engines.python` への参照が 0 件であることを確認します。')
    const hits = grepHits(String.raw`uv run|pyproject|engines\.python`, { scope: 'plugins/pecot-visual', extended: true })
    expect(hits).toEqual([])
  })

  it('plugins/pecot-visual/cli に、Python の実装が存在しない', async () => {
    // #475 で plugins/pecot-visual/cli/ への rename が完了済み。cli/pyproject.toml が無いこと、
    // および cli/src/** と cli/scripts/** に *.py が無いことを assert する。
    // glob をこの 2 ディレクトリに限定するのは cli/node_modules/ 配下の
    // 第三者パッケージ同梱 *.py を拾わないため (cli/ 全体の走査はしていない)。
    await explains('Python の実装を撤去したことのテストです。`cli/pyproject.toml` が存在せず、`cli/src` と `cli/scripts` の下に `*.py` が 0 件であることを確認します。')
    const cliRoot = path.join(PLUGIN_ROOT, 'cli')
    expect(existsSync(path.join(cliRoot, 'pyproject.toml'))).toBe(false)
    const pythonInSource = globSync('cli/src/**/*.py', { cwd: PLUGIN_ROOT })
    expect(pythonInSource).toEqual([])
    const pythonInScripts = globSync('cli/scripts/**/*.py', { cwd: PLUGIN_ROOT })
    expect(pythonInScripts).toEqual([])
  })

  it('plugins/pecot-visual に pyproject.toml が存在しない', async () => {
    await explains('Python の設定を撤去したことのテストです。`plugins/pecot-visual/pyproject.toml` が存在しないことを確認します。')
    expect(existsSync(path.join(PLUGIN_ROOT, 'pyproject.toml'))).toBe(false)
  })

  it('plugins/pecot-visual に uv.lock が存在しない', async () => {
    await explains('Python の依存の固定を撤去したことのテストです。`plugins/pecot-visual/uv.lock` が存在しないことを確認します。')
    expect(existsSync(path.join(PLUGIN_ROOT, 'uv.lock'))).toBe(false)
  })

  it('v-drawio のスキルに、Python の drawio-url.py が存在しない', async () => {
    await explains('Python のスクリプトを撤去したことのテストです。`skills/v-drawio/scripts/drawio-url.py` が存在しないことを確認します。')
    expect(existsSync(path.join(PLUGIN_ROOT, 'skills', 'v-drawio', 'scripts', 'drawio-url.py'))).toBe(false)
  })

  it('PATH 制限環境で dist/main.js が stdin の EOF で exit 0 (Python 不要を物的検証)', async () => {
    await explains('Python が存在しない環境のテストです。`PATH` を制限した環境で `dist/main.js` を標準入力が空のまま実行した場合に、標準出力へ何も出力せず、終了コードが 0 であることを確認します。')
    // 事前 build 済みを前提とする（run-tests.sh の build ステップが満たす）。純粋にランタイム特性だけを評価する。
    const result = spawnSync(process.execPath, [CLI_TS_DIST], {
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/tmp' },
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    })
    attachOutput('dist/main.js（PATH 制限・stdin は EOF）', result.status ?? undefined, result.stdout, result.stderr)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
