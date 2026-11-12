/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは createSandbox が作った一時 root 配下のみ */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { compareStrings } from './baseline.js'
import { parseScenario } from './scenario.js'
import type { Sandbox } from './setup.js'
import { baseEnvironment, createSandbox, destroySandbox, pluginRoot } from './setup.js'

const sandboxes: Sandbox[] = []

function make(yaml: string): Sandbox {
  const sandbox = createSandbox(parseScenario('issue-read-ok', `id: issue-read-ok\ncommand: { path: [issue, read] }\n${yaml}`))
  sandboxes.push(sandbox)
  return sandbox
}

function run(sandbox: Sandbox, command: string, arguments_: readonly string[]): string {
  return execFileSync(command, arguments_, { cwd: sandbox.repositoryDirectory, env: baseEnvironment(sandbox), encoding: 'utf8' })
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) destroySandbox(sandbox)
})

describe('createSandbox', () => {
  it('origin は git@host:owner/repo.git の形で、偽 ssh 経由で bare に届く', () => {
    const sandbox = make(`setup:
  repo:
    owner: o
    name: r
    branch: feat/1
    branches: [{ name: develop }]
    commits: [{ message: second, files: { a.txt: A } }]
`)
    expect(run(sandbox, 'git', ['remote', 'get-url', 'origin']).trim()).toBe('git@ghes.example.com:o/r.git')
    const references = run(sandbox, 'git', ['ls-remote', 'origin']).split('\n').filter(Boolean).map(line => line.split('\t', 2)[1] ?? '').toSorted(compareStrings)
    expect(references).toEqual(['HEAD', 'refs/heads/develop', 'refs/heads/main'])
    expect(run(sandbox, 'git', ['branch', '--show-current']).trim()).toBe('feat/1')
    expect(run(sandbox, 'git', ['log', '--format=%s', 'origin/main']).trim().split('\n')).toEqual(['second', 'initial commit'])
    expect(run(sandbox, 'git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim()).toBe('origin/main')
    // push・fetch も通る
    run(sandbox, 'git', ['push', '-q', 'origin', 'feat/1'])
    run(sandbox, 'git', ['fetch', '-q', 'origin'])
  })

  it('同じ入力ならコミットの SHA が同じになる', () => {
    const yaml = 'setup:\n  repo:\n    commits: [{ message: m, files: { a.txt: A } }]\n'
    const first = run(make(yaml), 'git', ['rev-parse', 'HEAD'])
    const second = run(make(yaml), 'git', ['rev-parse', 'HEAD'])
    expect(first).toBe(second)
  })

  it('files はコミットせず作業ツリーに置き、symlink も置ける。data はデータ置き場に置く', () => {
    const sandbox = make(`setup:
  repo:
    files: { .pecot/state/flag: on, link: { symlink: .pecot/state/flag } }
  data: { config/hosts.json: "{}" }
`)
    expect(readFileSync(path.join(sandbox.repositoryDirectory, '.pecot/state/flag'), 'utf8')).toBe('on')
    expect(lstatSync(path.join(sandbox.repositoryDirectory, 'link')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(sandbox.dataDirectory, 'config/hosts.json'), 'utf8')).toBe('{}')
    expect(run(sandbox, 'git', ['status', '--porcelain']).trim()).toBe('?? link')
  })

  it('gh stub は token があれば auth token で返し、無ければ exit 1', () => {
    const withToken = make('setup:\n  gh: { token: abc }\n')
    expect(run(withToken, 'gh', ['auth', 'token']).trim()).toBe('abc')
    const without = make('')
    expect(() => run(without, 'gh', ['auth', 'token'])).toThrow()
  })

  it('雛形に依存せず、info/exclude は固定の中身で hooks も無い', () => {
    const sandbox = make('')
    expect(readFileSync(path.join(sandbox.repositoryDirectory, '.git/info/exclude'), 'utf8')).toBe('# parity fixed exclude\n')
    expect(existsSync(path.join(sandbox.repositoryDirectory, '.git/hooks'))).toBe(false)
    expect(existsSync(path.join(sandbox.root, 'remotes/acme/demo.git/hooks'))).toBe(false)
  })

  it('ブランチごとにコミットを積んで push し、HEAD は branch のまま', () => {
    const sandbox = make(`setup:
  repo:
    branch: feat/1
    branches:
      - name: release
        commits: [{ message: on release, files: { r.txt: R } }]
      - name: feat/1
`)
    expect(run(sandbox, 'git', ['log', '--format=%s', 'origin/release']).trim().split('\n')).toEqual(['on release', 'initial commit'])
    expect(run(sandbox, 'git', ['log', '--format=%s', 'origin/feat/1']).trim()).toBe('initial commit')
    expect(run(sandbox, 'git', ['branch', '--show-current']).trim()).toBe('feat/1')
    expect(existsSync(path.join(sandbox.repositoryDirectory, 'r.txt'))).toBe(false)
  })

  it('タグは at のブランチか HEAD に付き、push: true なら origin にも出る', () => {
    const sandbox = make(`setup:
  repo:
    branches: [{ name: release, commits: [{ message: m, files: { r.txt: R } }] }]
    tags:
      - { name: v0.1.0, push: true }
      - { name: v0.2.0, at: release }
`)
    expect(run(sandbox, 'git', ['rev-parse', 'v0.1.0']).trim()).toBe(run(sandbox, 'git', ['rev-parse', 'main']).trim())
    expect(run(sandbox, 'git', ['rev-parse', 'v0.2.0']).trim()).toBe(run(sandbox, 'git', ['rev-parse', 'release']).trim())
    const remote = run(sandbox, 'git', ['ls-remote', '--tags', 'origin'])
    expect(remote).toContain('refs/tags/v0.1.0')
    expect(remote).not.toContain('refs/tags/v0.2.0')
  })

  it('worktrees は本物の git worktree で、list に出る', () => {
    const sandbox = make(`setup:
  repo:
    worktrees: [{ name: wt1 }, { name: wt2, branch: feat/x }]
`)
    const list = run(sandbox, 'git', ['worktree', 'list', '--porcelain'])
    expect(list).toContain(`worktree ${path.join(sandbox.root, 'wt1', 'demo')}`)
    expect(list).toContain('branch refs/heads/feat/x')
    expect(existsSync(path.join(sandbox.root, 'wt2', 'demo', 'README.md'))).toBe(true)
  })

  it('worktrees の files は worktree を作った後に置き、コミットしない', () => {
    const sandbox = make(`setup:
  repo:
    worktrees:
      - name: wt1
        files: { .pecot/state/flag: on, link: { symlink: .pecot/state/flag } }
`)
    const worktreeDirectory = path.join(sandbox.root, 'wt1', 'demo')
    expect(readFileSync(path.join(worktreeDirectory, '.pecot/state/flag'), 'utf8')).toBe('on')
    expect(lstatSync(path.join(worktreeDirectory, 'link')).isSymbolicLink()).toBe(true)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktreeDirectory, env: baseEnvironment(sandbox), encoding: 'utf8' }).trim()).toBe('?? link')
  })

  it('一時 root がリポジトリの中にあっても、親をたどって実リポを読まない', () => {
    const previous = process.env['TMPDIR']
    const outer = path.join(pluginRoot, '..', '..', '.pecot', 'work', '1314')
    mkdirSync(outer, { recursive: true })
    process.env['TMPDIR'] = outer
    try {
      const sandbox = make('')
      expect(sandbox.root.startsWith(realpathSync(outer))).toBe(true)
      // base は作業リポの 1 つ上。親をたどれば実リポに当たるが、ceiling で止まる
      expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: path.join(sandbox.root, 'base'),
        env: baseEnvironment(sandbox),
        stdio: 'pipe',
      })).toThrow()
    }
    finally {
      if (previous === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previous
    }
  })

  it('作成の途中で失敗したら、一時ディレクトリを消して投げ直す', () => {
    const previous = process.env['TMPDIR']
    const outer = path.join(pluginRoot, '..', '..', '.pecot', 'work', '1314', 'A-fail')
    rmSync(outer, { recursive: true, force: true })
    mkdirSync(outer, { recursive: true })
    process.env['TMPDIR'] = outer
    try {
      // tags の at が存在しない ref なので git tag が失敗する
      expect(() => make('setup:\n  repo:\n    tags: [{ name: v1, at: no-such-ref }]\n')).toThrow()
      expect(readdirSync(outer)).toEqual([])
    }
    finally {
      if (previous === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = previous
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it('destroySandbox で一時 root が消える', () => {
    const sandbox = createSandbox(parseScenario('issue-read-ok', 'id: issue-read-ok\ncommand: { path: [issue, read] }\n'))
    expect(existsSync(sandbox.root)).toBe(true)
    destroySandbox(sandbox)
    expect(existsSync(sandbox.root)).toBe(false)
  })
})
