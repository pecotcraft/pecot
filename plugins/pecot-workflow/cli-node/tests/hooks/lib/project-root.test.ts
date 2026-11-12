/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// lib/core/project-root.sh の解決順のテスト。
// 入力 JSON の .cwd → CLAUDE_PROJECT_DIR → プロセスの pwd の順に、候補を試す。
// GIT_* を外した `git rev-parse --show-toplevel` が成功した最初の値を、CLAUDE_PROJECT_DIR に export する。
// どれも git 外なら、CLAUDE_PROJECT_DIR は変更しない。
import { mkdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { gitRepository, workLayout } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

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
  const result = run(hookCase, 'bash', ['-c', `source "$1" "$2"; printf "%s" "\${CLAUDE_PROJECT_DIR-${UNSET}}"`, 'bash', PROJECT_ROOT_SH, inputJson], {
    cwd: options.cwd,
    env: { CLAUDE_PROJECT_DIR: options.projectDirectory, ...options.extraEnvironment },
  })
  if (result.exitCode !== 0) throw new Error(`bash が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
  return result.stdout
}

function real(target: string): string {
  return realpathSync(target)
}

function git(hookCase: HookCase, cwd: string, ...argv: readonly string[]): void {
  const result = run(hookCase, 'git', argv, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
}

describe('project-root.sh', () => {
  it('tool の cwd がサブディレクトリのとき、そのリポの toplevel に解決する', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'tool-repo')
    const sub = path.join(repository, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const session = gitRepository(hookCase, 'session-repo')

    const resolved = resolve(hookCase, { cwd: sub }, { cwd: hookCase.temporaryPath, projectDirectory: session })
    expect(resolved).toBe(real(repository))
  })

  it('cwd が git の外のとき、CLAUDE_PROJECT_DIR にフォールバックする', () => {
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session-repo')
    const sub = path.join(session, 'sub')
    mkdirSync(sub)
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: hookCase.temporaryPath, projectDirectory: sub })
    expect(resolved).toBe(real(session))
  })

  it('cwd と CLAUDE_PROJECT_DIR のどちらも無いとき、プロセスの pwd にフォールバックする', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase, 'pwd-repo')
    const sub = path.join(repository, 'deep')
    mkdirSync(sub)

    const resolved = resolve(hookCase, { session_id: 's' }, { cwd: sub, projectDirectory: undefined })
    expect(resolved).toBe(real(repository))
  })

  it('すべて git の外のとき、CLAUDE_PROJECT_DIR は未設定のままにする', () => {
    const hookCase = createHookCase()
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: loose, projectDirectory: undefined })
    expect(resolved).toBe(UNSET)
  })

  it('すべて git の外のとき、渡された CLAUDE_PROJECT_DIR を保つ', () => {
    const hookCase = createHookCase()
    const loose = path.join(hookCase.temporaryPath, 'loose')
    mkdirSync(loose)
    const given = path.join(hookCase.temporaryPath, 'given')
    mkdirSync(given)

    const resolved = resolve(hookCase, { cwd: loose }, { cwd: loose, projectDirectory: given })
    expect(resolved).toBe(given)
  })

  it('入力が空のとき、CLAUDE_PROJECT_DIR を使う', () => {
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session-repo')
    expect(resolve(hookCase, undefined, { cwd: hookCase.temporaryPath, projectDirectory: session })).toBe(real(session))
  })

  it('GIT_DIR が export されていても、漏らさない', () => {
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
  ])('cwd が base の $label のとき、セッションの worktree に解決する', (row) => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, row.sub)
    const resolved = resolve(hookCase, { cwd }, { cwd: layout.base, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.wt))
  })

  it('cwd が worktree の link 経由の work 配下のとき、セッションの worktree に解決する', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.wtWork, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.wt))
  })

  it('base の work 配下で、セッションが base のとき、base のままにする', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.base })
    expect(resolved).toBe(real(layout.base))
  })

  it('cwd が work の外のとき、セッションの worktree を無視する', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const resolved = resolve(hookCase, { cwd: layout.base }, { cwd: layout.base, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work に名前が似たディレクトリには、一致させない', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.base, '.pecot', 'work2')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work 配下で CLAUDE_PROJECT_DIR が無いとき、cwd の toplevel にフォールバックする', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: undefined })
    expect(resolved).toBe(real(layout.base))
  })

  it('work の link が切れているとき、cwd の toplevel にフォールバックする', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    unlinkSync(layout.wtWork)
    symlinkSync('../../missing/.pecot/work', layout.wtWork)
    const cwd = path.join(layout.work, '1244')
    const resolved = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    expect(resolved).toBe(real(layout.base))
  })

  it('work 配下でも、GIT_DIR が export されていても漏らさない', () => {
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

  it('work 配下で解決した値は、もう一度解決しても変わらない', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const cwd = path.join(layout.work, '1244')
    const first = resolve(hookCase, { cwd }, { cwd, projectDirectory: layout.wt })
    const second = resolve(hookCase, { cwd }, { cwd, projectDirectory: first })
    expect(second).toBe(first)
    expect(first).toBe(real(layout.wt))
  })

  it('work 配下に clone した入れ子のリポは、そのリポの toplevel に解決する', () => {
    // .pecot/work/N に clone した入れ子のリポは、セッションの worktree ではなくそのリポが基準。
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const nested = path.join(layout.work, '1244', 'clone')
    mkdirSync(nested)
    git(hookCase, nested, 'init', '--quiet')
    mkdirSync(path.join(nested, 'src'))
    const resolvedAtTop = resolve(hookCase, { cwd: nested }, { cwd: nested, projectDirectory: layout.wt })
    const resolvedInSub = resolve(hookCase, { cwd: path.join(nested, 'src') }, { cwd: path.join(nested, 'src'), projectDirectory: layout.wt })
    expect(resolvedAtTop).toBe(real(nested))
    expect(resolvedInSub).toBe(real(nested))
  })

  it('入れ子が .git ファイル（worktree・submodule）でも、そのリポの toplevel に解決する', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const nested = path.join(layout.work, '1244', 'linked')
    git(hookCase, layout.base, 'worktree', 'add', '-q', '-b', 'nested/x', nested)
    expect(statSync(path.join(nested, '.git')).isFile()).toBe(true)
    const resolved = resolve(hookCase, { cwd: nested }, { cwd: nested, projectDirectory: layout.wt })
    expect(resolved).toBe(real(nested))
  })

  it('別リポの work 配下は、セッションの worktree にせず、そのリポに解決する', () => {
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

describe('project-root.sh の元の値の退避', () => {
  it('上書き前の CLAUDE_PROJECT_DIR を PECOT_ORIGINAL_CLAUDE_PROJECT_DIR に残す', () => {
    const hookCase = createHookCase()
    const origin = gitRepository(hookCase, 'origin-repo')
    const other = gitRepository(hookCase, 'other-repo')
    const result = run(hookCase, 'bash', [
      '-c',
      'source "$1" "$2"; printf "%s|%s" "$CLAUDE_PROJECT_DIR" "$PECOT_ORIGINAL_CLAUDE_PROJECT_DIR"',
      'bash',
      PROJECT_ROOT_SH,
      jsonDumps({ cwd: other }),
    ], { cwd: other, env: { CLAUDE_PROJECT_DIR: origin } })
    expect(result.stdout).toBe(`${real(other)}|${origin}`)
  })
})
