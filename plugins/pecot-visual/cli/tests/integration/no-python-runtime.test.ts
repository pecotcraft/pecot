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

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const CLI_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
const CLI_TS_DIST = path.resolve(PLUGIN_ROOT, 'cli', 'dist', 'cli.js')
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
  it('(a) repo 全体に PECOTV_RUNTIME 参照が無い', () => {
    // 旧 Python ランタイムの切替変数 PECOTV_RUNTIME が対象。実行用ミラーを指す PECOTV_RUNTIME_DIR (#1230) は別物
    const hits = grepHits(String.raw`PECOTV_RUNTIME\b`, { extended: true })
    expect(hits).toEqual([])
  })

  it('(b) plugins/pecot-visual/ 配下に uv run / pyproject / engines.python 参照が無い', () => {
    const hits = grepHits(String.raw`uv run|pyproject|engines\.python`, { scope: 'plugins/pecot-visual', extended: true })
    expect(hits).toEqual([])
  })

  it('plugins/pecot-visual/cli/ 配下に Python 実装の痕跡が無い', () => {
    // #475 で plugins/pecot-visual/cli/ への rename が完了済み。cli/pyproject.toml が無いこと、
    // および cli/src/** と cli/scripts/** に *.py が無いことを assert する。
    // glob をこの 2 ディレクトリに限定するのは cli/node_modules/ 配下の
    // 第三者パッケージ同梱 *.py を拾わないため (cli/ 全体の走査はしていない)。
    const cliRoot = path.join(PLUGIN_ROOT, 'cli')
    expect(existsSync(path.join(cliRoot, 'pyproject.toml'))).toBe(false)
    const pythonInSource = globSync('cli/src/**/*.py', { cwd: PLUGIN_ROOT })
    expect(pythonInSource).toEqual([])
    const pythonInScripts = globSync('cli/scripts/**/*.py', { cwd: PLUGIN_ROOT })
    expect(pythonInScripts).toEqual([])
  })

  it('plugins/pecot-visual/pyproject.toml が存在しない', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'pyproject.toml'))).toBe(false)
  })

  it('plugins/pecot-visual/uv.lock が存在しない', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'uv.lock'))).toBe(false)
  })

  it('plugins/pecot-visual/skills/v-drawio/scripts/drawio-url.py が存在しない', () => {
    expect(existsSync(path.join(PLUGIN_ROOT, 'skills', 'v-drawio', 'scripts', 'drawio-url.py'))).toBe(false)
  })

  it('PATH 制限環境で pecotv --help が exit 0 (Python 不要を物的検証)', () => {
    // bootstrap ルートは対象外。事前 build/install 済みを前提とする
    // （run-tests.sh の build ステップが満たす）。
    // stale marker 等の bootstrap 起因のフレークを避けるため、PECOTV_BOOTSTRAP_SKIP=1 を注入して bin/pecotv を通過させる。
    // 純粋にランタイム特性（Python 不要で exit 0）だけを評価する。
    const nodeBin = path.dirname(execSync('command -v node', { encoding: 'utf8' }).trim())
    // CLAUDE_PLUGIN_ROOT を渡して bin/pecotv の realpath ルートを回避（macOS で /usr/bin/realpath が無い場合のフレーク予防）
    const result = spawnSync('env', [
      '-i',
      'PECOTV_BOOTSTRAP_SKIP=1',
      `CLAUDE_PLUGIN_ROOT=${PLUGIN_ROOT}`,
      `PATH=${nodeBin}:/usr/bin:/bin`,
      'HOME=/tmp',
      BIN_PECOTV,
      '--help',
    ], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
  })
})
