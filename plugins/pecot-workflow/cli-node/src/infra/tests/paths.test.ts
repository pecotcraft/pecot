/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProjectRootNotFoundError } from '../../domain/errors.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, createSessionWorkLayout } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { pluginRoot } from '../../version.js'
import {
  ACTIVE_PROJECT_FILENAME,
  PECOT_DIR,
  PECOT_GITIGNORE_FILENAME,
  CONFIG_DIR,
  dataDirectory,
  HOOKS_CONFIG_FILENAME,
  OUTPUT_DIR,
  outputDirectory,
  OutputPathReservationError,
  projectRoot,
  reserveOutputPath,
  resolveRealPath,
  STATE_DIR,
  WORK_DIR,
  WORKTREE_CONFIG_FILENAME,
  WORKTREE_IGNORE_FILENAME,
  withReservedOutputPath,
  withReservedOutputPathAsync,
} from '../paths.js'

useIsolatedEnvironment()

describe('パス定数', () => {
  it('.pecot/ 配下の値', () => {
    expect(PECOT_DIR).toBe('.pecot')
    expect(STATE_DIR).toBe('.pecot/state')
    expect(WORK_DIR).toBe('.pecot/work')
    expect(CONFIG_DIR).toBe('.pecot/config')
    expect(OUTPUT_DIR).toBe('.pecot/tmp/output')
    expect(WORKTREE_CONFIG_FILENAME).toBe('.pecot/config/worktree-config.json')
    expect(WORKTREE_IGNORE_FILENAME).toBe('.pecot/config/.worktreeignore')
    expect(HOOKS_CONFIG_FILENAME).toBe('.pecot/config/hooks-config.json')
    expect(ACTIVE_PROJECT_FILENAME).toBe('.pecot/config/projects/.active')
    expect(PECOT_GITIGNORE_FILENAME).toBe('.pecot/.gitignore')
  })
})

describe('projectRoot', () => {
  it('CLAUDE_PROJECT_DIR があればそれ（テスト上書き用）', () => {
    const directory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot()).toBe(directory)
  })

  it('CLAUDE_PROJECT_DIR は git のルートより優先される', () => {
    const directory = makeTemporaryDirectory()
    const repository = createGitRepository()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot({ cwd: repository })).toBe(directory)
  })

  it('環境変数が無ければ git のルート', () => {
    const repository = createGitRepository()
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })

  it('既定の cwd は呼び出し元の作業ディレクトリ', () => {
    const repository = createGitRepository()
    const previous = process.cwd()
    process.chdir(repository)
    try {
      expect(projectRoot()).toBe(repository)
    }
    finally {
      process.chdir(previous)
    }
  })

  it('git の外で環境変数も無ければ ProjectRootNotFoundError', () => {
    const directory = makeTemporaryDirectory()
    expect(() => projectRoot({ cwd: directory })).toThrow(ProjectRootNotFoundError)
    expect(() => projectRoot({ cwd: directory })).toThrow('project root not found: run inside a git repository or set the CLAUDE_PROJECT_DIR environment variable')
  })

  it('作業ディレクトリが消えていたら git のルートは得られず ProjectRootNotFoundError', () => {
    const removed = path.join(makeTemporaryDirectory(), 'removed')
    mkdirSync(removed)
    const previous = process.cwd()
    process.chdir(removed)
    try {
      rmdirSync(removed)
      expect(() => projectRoot()).toThrow(ProjectRootNotFoundError)
    }
    finally {
      process.chdir(previous)
    }
  })

  it('CLAUDE_PROJECT_DIR は Path と同じ形に正規化する（末尾のスラッシュ・重複スラッシュ・.）', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: '/a//b/./c/' })
    expect(projectRoot()).toBe('/a/b/c')
  })

  it('GIT_* が別の場所を指していても cwd 基準で解決する', () => {
    const repository = createGitRepository()
    setEnvironment({ GIT_DIR: path.join(repository, 'nonexistent.git') })
    expect(projectRoot({ cwd: repository })).toBe(repository)
  })
})

function useLayout(): ReturnType<typeof createSessionWorkLayout> {
  const layout = createSessionWorkLayout()
  setEnvironment({ PECOT_SESSION_PROJECT_DIR: layout.worktree })
  return layout
}

describe('projectRoot（セッションの worktree の .pecot/work）', () => {
  it('base の .pecot/work/N から起動すると worktree を返す', () => {
    const layout = useLayout()
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work', '1244') })).toBe(layout.worktree)
  })

  it('worktree 側の symlink 経由でも worktree を返す', () => {
    const layout = useLayout()
    expect(projectRoot({ cwd: path.join(layout.worktree, '.pecot', 'work', '1244') })).toBe(layout.worktree)
  })

  it('.pecot/work 自身でも worktree を返す', () => {
    const layout = useLayout()
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work') })).toBe(layout.worktree)
  })

  it('.pecot/work の深い下でも worktree を返す', () => {
    const layout = useLayout()
    const deep = path.join(layout.base, '.pecot', 'work', '1244', 'sub', 'deep')
    mkdirSync(deep, { recursive: true })
    expect(projectRoot({ cwd: deep })).toBe(layout.worktree)
  })

  it('.pecot/work2 は work ではない', () => {
    const layout = useLayout()
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work2') })).toBe(layout.base)
  })

  it('work の外は git のルート', () => {
    const layout = useLayout()
    expect(projectRoot({ cwd: layout.base })).toBe(layout.base)
  })

  it('別のリポジトリの .pecot/work はそのリポジトリ', () => {
    useLayout()
    const other = createGitRepository()
    const task = path.join(other, '.pecot', 'work', '9')
    mkdirSync(task, { recursive: true })
    expect(projectRoot({ cwd: task })).toBe(other)
  })

  it('work の中の入れ子の git リポジトリは、その toplevel', () => {
    const layout = useLayout()
    const clone = path.join(layout.base, '.pecot', 'work', '1244', 'clone')
    createGitRepository({ 'README.md': 'x', 'src/a.txt': 'y' }, clone)
    expect(projectRoot({ cwd: path.join(clone, 'src') })).toBe(clone)
  })

  it('セッションの値は末尾のスラッシュを落として解決する', () => {
    const layout = createSessionWorkLayout()
    setEnvironment({ PECOT_SESSION_PROJECT_DIR: `${layout.worktree}/` })
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work', '1244') })).toBe(layout.worktree)
  })

  it('cwd が無くなっていたら git にフォールバックし、そこも失敗すれば ProjectRootNotFoundError', () => {
    useLayout()
    expect(() => projectRoot({ cwd: path.join(makeTemporaryDirectory(), 'removed') })).toThrow(ProjectRootNotFoundError)
  })

  it('セッションの値がシンボリックリンクの循環で解決できなければ、セッションの判定は見送って git のルート', () => {
    const layout = createSessionWorkLayout()
    const loopRoot = makeTemporaryDirectory()
    symlinkSync(path.join(loopRoot, 'b'), path.join(loopRoot, 'a'))
    symlinkSync(path.join(loopRoot, 'a'), path.join(loopRoot, 'b'))
    setEnvironment({ PECOT_SESSION_PROJECT_DIR: path.join(loopRoot, 'a') })
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work', '1244') })).toBe(layout.base)
  })

  it('セッションの値が無ければ git のルート', () => {
    const layout = useLayout()
    setEnvironment({ PECOT_SESSION_PROJECT_DIR: undefined })
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work', '1244') })).toBe(layout.base)
  })

  it('CLAUDE_PROJECT_DIR が最優先', () => {
    const layout = useLayout()
    const directory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(projectRoot({ cwd: path.join(layout.base, '.pecot', 'work', '1244') })).toBe(directory)
  })
})

describe('resolveRealPath', () => {
  it('存在しない部分は、存在する最も深い親を解決して字句どおりにつなぐ', () => {
    const root = makeTemporaryDirectory()
    const link = path.join(root, 'link')
    mkdirSync(path.join(root, 'real'))
    symlinkSync(path.join(root, 'real'), link)
    expect(resolveRealPath(path.join(link, 'not', 'yet'))).toBe(path.join(root, 'real', 'not', 'yet'))
  })

  it('ENOENT 以外のエラー（循環）は投げる', () => {
    const root = makeTemporaryDirectory()
    symlinkSync(path.join(root, 'b'), path.join(root, 'a'))
    symlinkSync(path.join(root, 'a'), path.join(root, 'b'))
    expect(() => resolveRealPath(path.join(root, 'a'))).toThrow(/ELOOP/u)
  })
})

describe('outputDirectory', () => {
  it('プロジェクトルート基準の .pecot/tmp/output', () => {
    const directory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: directory })
    expect(outputDirectory()).toBe(path.join(directory, '.pecot', 'tmp', 'output'))
  })

  it('絶対パス', () => {
    const repository = createGitRepository()
    expect(path.isAbsolute(outputDirectory({ cwd: repository }))).toBe(true)
    expect(outputDirectory({ cwd: repository }).split(path.sep).slice(-3)).toEqual(['.pecot', 'tmp', 'output'])
  })
})

const FIXED_NOW = (): Date => new Date(2026, 4, 13, 10, 0, 0)
const commentName = (timestamp: string): string => `comment-plan-${timestamp}.md`
const createName = (timestamp: string): string => `pr-create-${timestamp}.md`

describe('reserveOutputPath', () => {
  it('同じ時刻で 2 回呼ぶと、1 秒進んだ別のパスになる', () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    const first = reserveOutputPath(output, commentName, { now: FIXED_NOW })
    const second = reserveOutputPath(output, commentName, { now: FIXED_NOW })
    expect(path.basename(first)).toBe('comment-plan-20260513-100000.md')
    expect(path.basename(second)).toBe('comment-plan-20260513-100001.md')
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
  })

  it('1 回の予約で時刻の取得は 1 回だけ', () => {
    const output = makeTemporaryDirectory()
    writeFileSync(path.join(output, 'pr-create-20260513-100000.md'), '先客')
    let calls = 0
    reserveOutputPath(output, timestamp => `pr-create-${timestamp}.md`, {
      now: () => {
        calls += 1
        return FIXED_NOW()
      },
    })
    expect(calls).toBe(1)
  })

  it('先客の候補名を 2 件飛ばし、先客の内容は変えない', () => {
    const output = makeTemporaryDirectory()
    const existing = ['pr-create-20260513-100000.md', 'pr-create-20260513-100001.md']
    for (const [index, name] of existing.entries()) writeFileSync(path.join(output, name), `SENTINEL-${String(index)}`)
    const reserved = reserveOutputPath(output, timestamp => `pr-create-${timestamp}.md`, { now: FIXED_NOW })
    expect(path.basename(reserved)).toBe('pr-create-20260513-100002.md')
    for (const [index, name] of existing.entries()) expect(readFileSync(path.join(output, name), 'utf8')).toBe(`SENTINEL-${String(index)}`)
  })

  it('出力先が無くても親ごと作り、返したファイルは空', () => {
    const output = path.join(makeTemporaryDirectory(), 'missing', 'output')
    const reserved = reserveOutputPath(output, timestamp => `comment-plan-${timestamp}.md`)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(reserved, 'utf8')).toBe('')
  })

  it('候補名を使い切ると OutputPathReservationError。文は Python と同じ', () => {
    const output = makeTemporaryDirectory()
    writeFileSync(path.join(output, 'fixed.md'), '先客')
    expect(() => reserveOutputPath(output, () => 'fixed.md', { maxAttempts: 3, now: FIXED_NOW })).toThrow(OutputPathReservationError)
    expect(() => reserveOutputPath(output, () => 'fixed.md', { maxAttempts: 3, now: FIXED_NOW }))
      .toThrow(`could not reserve an output path: all 3 candidate names are in use (last candidate: ${path.join(output, 'fixed.md')})`)
    expect(readFileSync(path.join(output, 'fixed.md'), 'utf8')).toBe('先客')
  })

  it('既定の時刻は現在時刻で、名前は YYYYMMDD-HHMMSS', () => {
    const reserved = reserveOutputPath(makeTemporaryDirectory(), timestamp => `x-${timestamp}.md`)
    expect(path.basename(reserved)).toMatch(/^x-\d{8}-\d{6}\.md$/u)
  })
})

describe('withReservedOutputPath', () => {
  it('正常終了なら書いた内容が残る', () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    const reserved = withReservedOutputPath(output, timestamp => `pr-create-${timestamp}.md`, (target) => {
      writeFileSync(target, '本文')
      return target
    }, { now: FIXED_NOW })
    expect(path.basename(reserved)).toBe('pr-create-20260513-100000.md')
    expect(readFileSync(reserved, 'utf8')).toBe('本文')
  })

  it('本文が例外を投げたら 0 バイトのファイルを残さず、例外はそのまま出る', () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    let reserved = ''
    expect(() => withReservedOutputPath(output, timestamp => `pr-create-${timestamp}.md`, (target) => {
      reserved = target
      expect(existsSync(target)).toBe(true)
      throw new Error('書き込み失敗')
    }, { now: FIXED_NOW })).toThrow('書き込み失敗')
    expect(existsSync(reserved)).toBe(false)
    expect(readdirSync(output)).toEqual([])
  })

  it('撤去した候補名は同じ秒の次の予約で再利用される', () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    expect(() => withReservedOutputPath(output, createName, () => {
      throw new Error('書き込み失敗')
    }, { now: FIXED_NOW })).toThrow('書き込み失敗')
    const second = withReservedOutputPath(output, createName, target => target, { now: FIXED_NOW })
    expect(path.basename(second)).toBe('pr-create-20260513-100000.md')
  })

  it('予約に失敗したら、本文は呼ばれず例外が出る', () => {
    const output = makeTemporaryDirectory()
    writeFileSync(path.join(output, 'fixed.md'), '先客')
    let isEntered = false
    expect(() => {
      withReservedOutputPath(output, () => 'fixed.md', () => {
        isEntered = true
      }, { maxAttempts: 2, now: FIXED_NOW })
    }).toThrow(OutputPathReservationError)
    expect(isEntered).toBe(false)
    expect(readFileSync(path.join(output, 'fixed.md'), 'utf8')).toBe('先客')
  })

  it('非同期の本文が失敗したときも予約を撤去する', async () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    await expect(withReservedOutputPathAsync(output, timestamp => `pr-${timestamp}.md`, async () => {
      await Promise.resolve()
      throw new Error('非同期の失敗')
    }, { now: FIXED_NOW })).rejects.toThrow('非同期の失敗')
    expect(readdirSync(output)).toEqual([])
  })

  it('撤去に失敗しても、本文が投げた元の例外を優先する', () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    expect(() => withReservedOutputPath(output, createName, (target) => {
      // 予約したファイルをディレクトリに差し替え、unlink を EISDIR・EPERM で失敗させる
      rmSync(target)
      mkdirSync(target)
      throw new Error('元の例外')
    }, { now: FIXED_NOW })).toThrow('元の例外')
  })

  it('非同期でも、撤去に失敗したときは元の例外を優先する', async () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    await expect(withReservedOutputPathAsync(output, createName, async (target) => {
      await Promise.resolve()
      rmSync(target)
      mkdirSync(target)
      throw new Error('元の非同期の例外')
    }, { now: FIXED_NOW })).rejects.toThrow('元の非同期の例外')
  })

  it('非同期の本文が成功したら残す', async () => {
    const output = path.join(makeTemporaryDirectory(), 'output')
    const reserved = await withReservedOutputPathAsync(output, timestamp => `pr-${timestamp}.md`, async (target) => {
      await Promise.resolve()
      writeFileSync(target, 'ok')
      return target
    }, { now: FIXED_NOW })
    expect(readFileSync(reserved, 'utf8')).toBe('ok')
  })
})

describe('dataDirectory は bin/_lib.sh の plugin_data_dir_resolve と同じ結果になる', () => {
  const libraryPath = path.join(pluginRoot(), 'bin', '_lib.sh')
  const PROJECT_NAME = 'pecot-workflow'

  /**
  bash で plugin_data_dir_resolve を呼ぶ。データ置き場の 3 変数・XDG_DATA_HOME・HOME を消してから values を設定する
  */
  function bashResolve(values: Readonly<Record<string, string>>): { readonly stdout: string, readonly status: number | null } {
    const environment: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...values }
    const result = spawnSync('bash', ['-c', `. "$1"; plugin_data_dir_resolve "$2"`, 'bash', libraryPath, PROJECT_NAME], { env: environment, encoding: 'utf8' })
    return { stdout: result.stdout, status: result.status }
  }

  const CASES: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['CLAUDE_PLUGIN_DATA が絶対パス', { CLAUDE_PLUGIN_DATA: '/data/claude', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の改行は落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\n\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の CR も落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\r\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が相対パスなら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: 'relative/dir', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が変数展開の書式なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: '/data/plugin' }],
    ['CLAUDE_PLUGIN_DATA が空なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '/data/plugin' }],
    ['PLUGIN_DATA だけ', { PLUGIN_DATA: '/data/plugin', XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が絶対パス', { XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が相対パスなら HOME', { XDG_DATA_HOME: 'xdg', HOME: '/home/u' }],
    ['HOME だけ', { HOME: '/home/u' }],
    ['HOME の末尾の改行は落とす', { HOME: '/home/u\n' }],
    ['HOME が相対パスなら解決できない', { HOME: 'relative' }],
    ['HOME が変数展開の書式なら解決できない', { HOME: '${HOME}' }],
    ['何も無ければ解決できない', {}],
    ['空白を含むパスは trim しない', { CLAUDE_PLUGIN_DATA: '/data/with space ' }],
  ]

  it.each(CASES)('%s のとき、bash と同じ場所を返す', (_name, values) => {
    const expected = bashResolve(values)
    // 未設定にした上で設定する（テストの env を bash に渡した env と一致させる）
    setEnvironment({ CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined, XDG_DATA_HOME: undefined, HOME: undefined })
    setEnvironment(values)
    const expectedDirectory = expected.status === 0 ? expected.stdout.replace(/\n$/u, '') : undefined
    expect(dataDirectory()).toBe(expectedDirectory)
  })

  it('bash の解決結果が実際に得られている（テストの前提）', () => {
    expect(execFileSync('bash', ['-c', `. "$1"; plugin_data_dir_resolve "$2"`, 'bash', libraryPath, PROJECT_NAME], { env: { PATH: process.env['PATH'] ?? '', HOME: '/home/u' }, encoding: 'utf8' }))
      .toBe(`/home/u/.local/share/pecot/${PROJECT_NAME}\n`)
  })
})
