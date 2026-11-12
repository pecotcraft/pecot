/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// bash-post-match.sh（PostToolUse(Bash) の一致判定）のテスト。
// 一致したときだけ対象リポジトリを解決する。環境変数 1 個が 128KiB を超えると execve が失敗するため、tool の stdout は export しない。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const SOURCE_AND_DUMP = [
  'PECOT_PROJECT_ROOT_LAZY=1; ',
  'source "$1/core/project-root.sh" "$2" && source "$1/post-tool-use/bash-post-match.sh" "$2" && ',
  'printf "%s\\0%s\\0%s\\0%s\\0" "$PECOT_POST_COMMIT" "$PECOT_POST_MATCHED" "$PECOT_POST_REPO_DIR" "${CLAUDE_PROJECT_DIR:-}" && ',
  'env | grep -c \'^PECOT_POST_STDOUT\' || true',
].join('')

const COMMIT_OUT = '[feat/x abc1234] msg\n 1 file changed, 1 insertion(+)'

const libraryDirectory = path.join(hooksDirectory, 'lib')

interface PayloadOptions {
  readonly client?: string
  readonly cwd?: string
}

function payloadOf(command: string, stdout: string, options: PayloadOptions = {}): string {
  const base = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  }
  if ((options.client ?? 'claude') === 'claude') {
    return jsonDumps({ ...base, tool_response: { stdout, interrupted: false } })
  }
  return jsonDumps({
    ...base,
    tool_result: {
      result_type: 'success',
      text_result_for_llm: `${stdout}\n<shellId: 0 completed with exit code 0>`,
    },
  })
}

interface Matched {
  readonly kind: string
  readonly repositoryDirectory: string
  readonly project: string
  readonly rest: string
}

// 先頭から count 個の区切りで分ける。残りは最後の要素に入れる。
function splitFirst(text: string, separator: string, count: number): string[] {
  const parts: string[] = []
  let rest = text
  for (let index = 0; index < count; index += 1) {
    const position = rest.indexOf(separator)
    if (position === -1) break
    parts.push(rest.slice(0, position))
    rest = rest.slice(position + separator.length)
  }
  parts.push(rest)
  return parts
}

function match(hookCase: HookCase, payload: string, cwd: string): Matched {
  const out = run(hookCase, 'bash', ['-c', SOURCE_AND_DUMP, '_', libraryDirectory, payload], { cwd })
  expect(out.exitCode).toBe(0)
  const [commit = '', matched = '', repositoryDirectory = '', project = '', rest = ''] = splitFirst(out.stdout, '\0', 4)
  // 判定結果を "commit" と "" にまとめる（MATCHED は COMMIT と一致する）。
  const kind = commit === '1' ? 'commit' : ''
  expect(matched).toBe(kind === '' ? '' : '1')
  return { kind, repositoryDirectory, project, rest: rest.trim() }
}

function setUpRepository(hookCase: HookCase): string {
  return gitRepository(hookCase, 'post-match')
}

function makeElsewhere(hookCase: HookCase): string {
  const elsewhere = path.join(hookCase.temporaryPath, 'elsewhere')
  mkdirSync(elsewhere)
  return elsewhere
}

describe('bash-post-match.sh', () => {
  it.for([
    { client: 'claude', clientName: 'Claude Code' },
    { client: 'copilot', clientName: 'Copilot CLI' },
  ])('$clientName の入力で commit が成功したとき、一致と判定し、対象リポジトリを解決する', (row) => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = match(hookCase, payloadOf('git commit -m x', COMMIT_OUT, { client: row.client, cwd: repository }), repository)
    expect(result.kind).toBe('commit')
    expect(result.repositoryDirectory).toBe(repository)
    expect(result.project).toBe(repository)
    expect(result.rest).toBe('0')
  })

  it.for(['git\tcommit -m x', 'git  commit -m x', 'echo a;  git\tcommit -m x', 'echo a &&\tgit  commit -m x'].map(command => ({
    command,
    label: command.replaceAll('\t', String.raw`\t`),
  })))('コマンドが $label のとき、タブや連続空白の区切りでも commit と一致する', (row) => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = match(hookCase, payloadOf(row.command, COMMIT_OUT, { cwd: repository }), repository)
    expect(result.kind).toBe('commit')
    expect(result.repositoryDirectory).toBe(repository)
  })

  it('タブ区切りの git -C で commit するとき、対象のリポジトリを解決する', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const elsewhere = makeElsewhere(hookCase)
    const result = match(hookCase, payloadOf(`git\t-C\t${repository}  commit -m x`, COMMIT_OUT, { cwd: elsewhere }), elsewhere)
    expect(result.kind).toBe('commit')
    expect(result.repositoryDirectory).toBe(repository)
  })

  it('git -C で commit するとき、対象のリポジトリを解決する', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const elsewhere = makeElsewhere(hookCase)
    const result = match(hookCase, payloadOf(`git -C ${repository} commit -m x`, COMMIT_OUT, { cwd: elsewhere }), elsewhere)
    expect(result.kind).toBe('commit')
    expect(result.repositoryDirectory).toBe(repository)
  })

  it('連結コマンドのとき、成功した commit の部分だけに一致する', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = match(hookCase, payloadOf('git commit -m x && pecot issue create x.md', COMMIT_OUT, { cwd: repository }), repository)
    expect(result.kind).toBe('commit')
    expect(result.repositoryDirectory).toBe(repository)
  })

  it.for([
    { label: 'ls', command: 'ls', stdout: 'f.txt' },
    { label: 'git status', command: 'git status', stdout: 'On branch main' },
    // 成功の出力（[branch sha]）が無い
    { label: 'git commit -m x（成功の出力なし）', command: 'git commit -m x', stdout: 'nothing to commit' },
    // issue の起票は CLI が処理し、hook は見ない
    { label: 'pecot issue create x.md', command: 'pecot issue create x.md', stdout: 'Created: #12' },
    // コマンドの先頭でない
    { label: 'echo \'git commit\'', command: 'echo \'git commit\'', stdout: 'git commit' },
  ])('コマンドが $label のとき、一致とせず、対象リポジトリも解決しない', (row) => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = match(hookCase, payloadOf(row.command, row.stdout, { cwd: repository }), repository)
    expect(result.kind).toBe('')
    expect(result.repositoryDirectory).toBe('')
    // 一致しなければ project-root は解決しない（CLAUDE_PROJECT_DIR は呼び出し元の値のまま）。
    expect(result.project).not.toBe(repository)
  })

  it('commit が中断されたとき、一致としない', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const payload = jsonDumps({
      tool_input: { command: 'git commit -m x' },
      tool_response: { stdout: COMMIT_OUT, interrupted: true },
      cwd: repository,
    })
    const result = match(hookCase, payload, repository)
    expect(result.kind).toBe('')
  })

  it('source したあとも、呼び出し元の位置パラメータを壊さない', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const script = [
      'PECOT_PROJECT_ROOT_LAZY=1; ',
      'source "$1/core/project-root.sh" "$2" && source "$1/post-tool-use/bash-post-match.sh" "$2" && ',
      'printf "%s|%s" "$1" "$#"',
    ].join('')
    const out = run(hookCase, 'bash', ['-c', script, '_', libraryDirectory, payloadOf('git commit -m x', COMMIT_OUT, { cwd: repository })], { cwd: repository })
    expect(out.stdout).toBe(`${libraryDirectory}|2`)
  })
})
