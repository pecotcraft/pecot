/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// lib/core/project-root.sh の解決順のテスト。
// 入力 JSON の .cwd → CLAUDE_PROJECT_DIR → プロセスの pwd の順に試す。
// GIT_* を外した `git rev-parse --show-toplevel` が成功した最初の値を export し、どれも git 外なら変更しない。
import { mkdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository, workLayout } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { runShell } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'
import { explains } from '../../_helpers/explains.js'

const UNSET = '<unset>'
const PROJECT_ROOT_SH = path.join(coreDirectory, 'project-root.sh')

interface ResolveOptions {
  readonly cwd: string
  // undefined のとき、CLAUDE_PROJECT_DIR を外す
  readonly projectDirectory: string | undefined
  readonly extraEnvironment?: EnvironmentOverrides
}

// project-root.sh を source した後の CLAUDE_PROJECT_DIR を返す（未設定は UNSET）。
function resolve(hookCase: HookCase, payload: unknown, options: ResolveOptions): string {
  const inputJson = payload === undefined ? '' : jsonDumps(payload)
  const result = runShell(hookCase, 'source "$1" "$2"; printf "%s" "${CLAUDE_PROJECT_DIR-$3}"', [PROJECT_ROOT_SH, inputJson, UNSET], {
    cwd: options.cwd,
    env: { CLAUDE_PROJECT_DIR: options.projectDirectory, ...options.extraEnvironment },
  })
  if (result.exitCode !== 0) throw new Error(`bash が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
  return result.stdout
}

function real(target: string): string {
  return realpathSync(target)
}

describe('project-root.sh', () => {
  it('tool の cwd がサブディレクトリのとき、そのリポの toplevel に解決する', async () => {
    await explains('`project-root.sh`（`CLAUDE_PROJECT_DIR` を解決するスクリプト）のテストです。ツールの `cwd` がリポジトリのサブディレクトリの場合に、そのリポジトリのルートに解決することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'tool-repo')
    const sub = path.join(repository, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const session = gitRepository(hookCase, 'session-repo')

    const resolved = resolve(hookCase, { cwd: sub }, { cwd: hookCase.temporaryPath, projectDirectory: session })
    expect(resolved).toBe(real(repository))
  })

  it('cwd が git の外のとき、CLAUDE_PROJECT_DIR にフォールバックする', async () => {
    await explains('`project-root.sh` のテストです。`cwd` が git リポジトリの外の場合に、`CLAUDE_PROJECT_DIR` のリポジトリのルートにフォールバックすることを確認します。')
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session-repo')
    const sub = path.join(session, 'sub')
    mkdirSync(sub)
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: hookCase.temporaryPath, projectDirectory: sub })
    expect(resolved).toBe(real(session))
  })

  it('cwd と CLAUDE_PROJECT_DIR のどちらも無いとき、プロセスの pwd にフォールバックする', async () => {
    await explains('`project-root.sh` のテストです。入力の `cwd` と `CLAUDE_PROJECT_DIR` のどちらもない場合に、プロセスの現在のディレクトリのリポジトリのルートにフォールバックすることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'pwd-repo')
    const sub = path.join(repository, 'deep')
    mkdirSync(sub)

    const resolved = resolve(hookCase, { session_id: 's' }, { cwd: sub, projectDirectory: undefined })
    expect(resolved).toBe(real(repository))
  })

  it('すべて git の外のとき、CLAUDE_PROJECT_DIR は未設定のままにする', async () => {
    await explains('`project-root.sh` のテストです。すべての候補が git リポジトリの外の場合に、`CLAUDE_PROJECT_DIR` を未設定のままにすることを確認します。')
    const hookCase = createHookCase()
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: loose, projectDirectory: undefined })
    expect(resolved).toBe(UNSET)
  })

  it('すべて git の外のとき、渡された CLAUDE_PROJECT_DIR を保つ', async () => {
    await explains('`project-root.sh` のテストです。すべての候補が git リポジトリの外の場合に、渡された `CLAUDE_PROJECT_DIR` の値を変更しないことを確認します。')
    const hookCase = createHookCase()
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)
    const given = path.join(hookCase.temporaryPath, 'given')
    mkdirSync(given)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: loose, projectDirectory: given })
    expect(resolved).toBe(given)
  })

  it('入力が空のとき、CLAUDE_PROJECT_DIR を使う', async () => {
    await explains('`project-root.sh` のテストです。入力が空の場合に、`CLAUDE_PROJECT_DIR` のリポジトリのルートを使うことを確認します。')
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session-repo')
    expect(resolve(hookCase, undefined, { cwd: hookCase.temporaryPath, projectDirectory: session })).toBe(real(session))
  })

  it('GIT_DIR が export されていても、漏らさない', async () => {
    await explains('`project-root.sh` のテストです。環境変数 `GIT_DIR` と `GIT_WORK_TREE` が設定されていても、その値の影響を受けず、`cwd` のリポジトリのルートに解決することを確認します。')
    // pre-push 等で GIT_DIR が export されていても cwd 側の toplevel を返す。
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'tool-repo')
    const other = gitRepository(hookCase, 'other-repo')

    const resolved = resolve(hookCase, { cwd: repository }, {
      cwd: hookCase.temporaryPath,
      projectDirectory: undefined,
      extraEnvironment: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other },
    })
    expect(resolved).toBe(real(repository))
  })
})

// worktree の .pecot/work（base への symlink）配下。
describe('project-root.sh の .pecot/work 配下', () => {
  it.for([
    { label: 'work/1244', sub: '1244' },
    { label: 'work/1244/sub', sub: '1244/sub' },
    { label: 'work 直下', sub: '' },
  ])('cwd が base の $label のとき、セッションの worktree に解決する', async (row) => {
    await explains(`\`project-root.sh\` の \`.pecot/work\` 配下のテストです。\`cwd\` が base の \`${row.label}\` の場合に、セッションの worktree に解決することを確認します。`)
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, row.sub)
    const resolved = resolve(hookCase, { cwd }, { cwd: layout.base, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.wt))
  })

  it('cwd が worktree の link 経由の work 配下のとき、セッションの worktree に解決する', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`cwd` が worktree のシンボリックリンク経由の `work` 配下の場合に、セッションの worktree に解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.wtWork, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.wt))
  })

  it('base の work 配下で、セッションが base のとき、base のままにする', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。base の `work` 配下で、セッションの起点も base の場合に、base のまま解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.base })
    expect(resolved).toBe(real(layout.base))
  })

  it('cwd が work の外のとき、セッションの worktree を無視する', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`cwd` が `work` の外の場合に、セッションの worktree を使わず、`cwd` のリポジトリのルートに解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const resolved = resolve(hookCase, { cwd: layout.base }, { cwd: layout.base, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work に名前が似たディレクトリには、一致させない', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`work2` のように名前が似たディレクトリを `work` として扱わず、`cwd` のリポジトリのルートに解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.base, '.pecot', 'work2')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work 配下で CLAUDE_PROJECT_DIR が無いとき、cwd の toplevel にフォールバックする', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`work` 配下で `CLAUDE_PROJECT_DIR` が設定されていない場合に、`cwd` のリポジトリのルートにフォールバックすることを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: undefined })
    expect(resolved).toBe(real(layout.base))
  })

  it('work の link が切れているとき、cwd の toplevel にフォールバックする', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`work` のシンボリックリンクの参照先が存在しない場合に、`cwd` のリポジトリのルートにフォールバックすることを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    unlinkSync(layout.wtWork)
    symlinkSync('../../missing/.pecot/work', layout.wtWork)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work 配下でも、GIT_DIR が export されていても漏らさない', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`work` 配下でも、環境変数 `GIT_DIR` と `GIT_WORK_TREE` の影響を受けず、セッションの worktree に解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const other = gitRepository(hookCase, 'other-repo')
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, {
      cwd,
      projectDirectory: layout.wt,
      extraEnvironment: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other },
    })
    expect(resolved).toBe(real(layout.wt))
  })

  it('work 配下で解決した値は、もう一度解決しても変わらない', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。解決した値を `CLAUDE_PROJECT_DIR` として再度渡しても、同じ値に解決されることを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const first = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    const second = resolve(hookCase, { cwd }, { cwd, projectDirectory: first })
    expect(second).toBe(first)
    expect(first).toBe(real(layout.wt))
  })

  it('work 配下に clone した入れ子のリポは、そのリポの toplevel に解決する', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。`work` 配下に clone した入れ子のリポジトリでは、セッションの worktree ではなく、その入れ子のリポジトリのルートに解決することを確認します。')
    // .pecot/work/N に clone した入れ子のリポは、セッションの worktree ではなくそのリポが基準。
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const nested = path.join(layout.work, '1244', 'clone')
    mkdirSync(nested)
    gitOrThrow(hookCase, nested, ['init', '--quiet'])
    mkdirSync(path.join(nested, 'src'))
    const resolvedAtTop = resolve(hookCase, { cwd: nested }, { cwd: nested, projectDirectory: layout.wt })
    const resolvedInSub = resolve(hookCase, { cwd: path.join(nested, 'src') }, { cwd: path.join(nested, 'src'), projectDirectory: layout.wt })
    expect(resolvedAtTop).toBe(real(nested))
    expect(resolvedInSub).toBe(real(nested))
  })

  it('入れ子が .git ファイル（worktree・submodule）でも、そのリポの toplevel に解決する', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。入れ子のリポジトリの `.git` がファイル（worktree や submodule）の場合でも、そのリポジトリのルートに解決することを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const nested = path.join(layout.work, '1244', 'linked')
    gitOrThrow(hookCase, layout.base, ['worktree', 'add', '-q', '-b', 'nested/x', nested])
    expect(statSync(path.join(nested, '.git')).isFile()).toBe(true)
    const resolved = resolve(hookCase, { cwd: nested }, { cwd: nested, projectDirectory: layout.wt })
    expect(resolved).toBe(real(nested))
  })

  it('別リポの work 配下は、セッションの worktree にせず、そのリポに解決する', async () => {
    await explains('`project-root.sh` の `.pecot/work` 配下のテストです。別のリポジトリの `work` 配下では、セッションの worktree ではなく、そのリポジトリのルートに解決することを確認します。')
    // 前置きの case に当たってもセッションの worktree にしない。
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const other = gitRepository(hookCase, 'other-repo')
    const cwd = path.join(other, '.pecot', 'work', '1244')
    mkdirSync(cwd, { recursive: true })
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(other))
  })
})
