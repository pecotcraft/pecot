/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// post-tool-use/auto-push.sh と stop/auto-push.sh のテスト。
// コミット成功後の WIP ブランチへの自動 push と、Stop hook での URL 表示を確かめる。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeProjectDirectory, createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HooksConfig, HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { mockBin } from '../_helpers/mock-bin.js'
import type { MockBin } from '../_helpers/mock-bin.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { run, runPostScript, runScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps, splitLines } from '../_helpers/text.js'

const AUTO_PUSH_SCRIPT = path.join(hooksDirectory, 'lib', 'post-tool-use', 'auto-push.sh')
const STOP_SCRIPT = path.join(hooksDirectory, 'lib', 'stop', 'auto-push.sh')
const DEFAULT_ORIGIN = 'git@ghes.example.com:testowner/testrepo.git'
const DEFAULT_BRANCH_NAME = 'feat/add-auth/1443'

// コミット成功の PostToolUse JSON を作る。
function commitSuccessJson(branch = DEFAULT_BRANCH_NAME): string {
  return jsonDumps({
    tool_input: { command: 'git commit -m "feat: add auth"' },
    tool_response: {
      stdout: `[${branch} abc1234] feat: add auth\n 1 file changed, 1 insertion(+)`,
      interrupted: false,
    },
  })
}

// 実 git の絶対パスを返す。mock-bin を PATH へ足す前に呼ぶ。
function resolveRealGit(hookCase: HookCase): string {
  const found = run(hookCase, 'sh', ['-c', 'command -v git']).stdout.trim()
  return found === '' ? 'git' : found
}

// push を記録し、それ以外は実 git へ exec する mock git の本体。
function mockGitBody(realGit: string, pushLog: string, pushExit = '0', pushStderr = ''): string {
  const stderrLine = pushStderr === '' ? [] : [`    echo ${JSON.stringify(pushStderr)} >&2`]
  return [
    '#!/bin/bash',
    `REAL_GIT=${JSON.stringify(realGit)}`,
    `PUSH_LOG=${JSON.stringify(pushLog)}`,
    `PUSH_EXIT=${JSON.stringify(pushExit)}`,
    'cmd="$1"',
    'if [ "$1" = "-C" ]; then',
    '    cmd="$3"',
    'fi',
    'if [ "$cmd" = "push" ]; then',
    '    echo "$@" > "$PUSH_LOG"',
    '    for arg in "$@"; do',
    '        case "$arg" in',
    '            HEAD:refs/heads/*)',

    '                dst="${arg#HEAD:refs/heads/}"',
    '                if [ "$1" = "-C" ]; then',
    '                    "$REAL_GIT" -C "$2" update-ref "refs/remotes/origin/$dst" HEAD',
    '                else',
    '                    "$REAL_GIT" update-ref "refs/remotes/origin/$dst" HEAD',
    '                fi ;;',
    '        esac',
    '    done',
    ...stderrLine,
    '    exit "$PUSH_EXIT"',
    'fi',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n')
}

// デフォルトブランチの取得と GraphQL（query と mutation）に答える mock gh の本体。
// 呼び出し回数のカウンタ（<log>.count）で、1 回目（query）と 2 回目（mutation）を出し分ける。
function mockGhBody(graphqlLog: string, graphqlExit = '0', mutationResponse = ''): string {
  const mutation = mutationResponse === ''
    ? '{"data":{"createLinkedBranch":{"linkedBranch":{"id":"LB_789"}}}}'
    : mutationResponse
  return [
    '#!/bin/bash',
    `GRAPHQL_LOG=${JSON.stringify(graphqlLog)}`,
    `GRAPHQL_EXIT=${JSON.stringify(graphqlExit)}`,
    'DEFAULT_BRANCH="main"',
    'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
    '    echo "$@" >> "$GRAPHQL_LOG"',
    '    if [ "$GRAPHQL_EXIT" != "0" ]; then',
    '        exit "$GRAPHQL_EXIT"',
    '    fi',

    '    COUNTER_FILE="${GRAPHQL_LOG}.count"',
    '    if [ ! -f "$COUNTER_FILE" ]; then',
    '        echo "1" > "$COUNTER_FILE"',
    '    else',
    '        count=$(cat "$COUNTER_FILE")',
    '        echo $((count + 1)) > "$COUNTER_FILE"',
    '    fi',
    '    count=$(cat "$COUNTER_FILE")',
    '    if [ "$count" -eq 1 ]; then',
    '        echo "I_issue123 R_repo456 abc123def456abc123def456abc123def456abc1"',
    '    else',
    `        echo ${JSON.stringify(mutation)}`,
    '    fi',
    '    exit 0',
    'fi',
    'if [ "$1" = "api" ]; then',
    '    echo "$DEFAULT_BRANCH"',
    '    exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n')
}

interface Setup {
  readonly realGit: string
  readonly config: HooksConfig
  readonly mock: MockBin
  readonly repository: string
  readonly pushLog: string
  readonly graphqlLog: string
  readonly stateDirectory: string
}

function git(hookCase: HookCase, repository: string, argv: readonly string[]): RunResult {
  return run(hookCase, 'git', ['-C', repository, ...argv])
}

function gitOrThrow(hookCase: HookCase, repository: string, argv: readonly string[]): string {
  const result = git(hookCase, repository, argv)
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が失敗しました: ${result.stderr}`)
  return result.stdout
}

// auto-push を有効にし、push と gh の標準モックを置き、テスト用リポを作る。
function setUpEnvironment(hookCase: HookCase): Setup {
  const project = claudeProjectDirectory(hookCase)
  const config = hooksConfig(hookCase)
  const realGit = resolveRealGit(hookCase)
  const pushLog = path.join(hookCase.temporaryPath, 'mock-git-push.log')
  const graphqlLog = path.join(hookCase.temporaryPath, 'mock-gh-graphql.log')
  config.write({ 'auto-push': true })
  const mock = mockBin(hookCase)
  mock.install('git', mockGitBody(realGit, pushLog))
  mock.install('gh', mockGhBody(graphqlLog))
  const repository = gitRepository(hookCase)
  gitOrThrow(hookCase, repository, ['remote', 'add', 'origin', DEFAULT_ORIGIN])
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(path.join(stateDirectory, '.pecot-active'), 'testowner/testrepo/1443\n')
  return { realGit, config, mock, repository, pushLog, graphqlLog, stateDirectory }
}

function checkout(hookCase: HookCase, setup: Setup, branch: string): void {
  gitOrThrow(hookCase, setup.repository, ['checkout', '-b', branch])
}

function setRemote(hookCase: HookCase, setup: Setup, url: string): void {
  gitOrThrow(hookCase, setup.repository, ['remote', 'set-url', 'origin', url])
}

// リポを cwd にして、エントリと同じ前段つきで auto-push.sh を動かす。
function runAutoPush(hookCase: HookCase, setup: Setup, stdin: string = commitSuccessJson()): RunResult {
  return runPostScript(hookCase, AUTO_PUSH_SCRIPT, stdin, { cwd: setup.repository })
}

function readText(file: string): string {
  return readFileSync(file, 'utf8')
}

function writePecotActive(setup: Setup): void {
  mkdirSync(setup.stateDirectory, { recursive: true })
  writeFileSync(path.join(setup.stateDirectory, '.pecot-active'), 'testowner/testrepo/1443\n')
}

// wip の追跡 ref の一覧
function listWipTrackingReferences(hookCase: HookCase, repository: string): string {
  return gitOrThrow(hookCase, repository, ['for-each-ref', 'refs/remotes/origin/wip/'])
}

function fetchRefspecs(hookCase: HookCase, repository: string): string[] {
  return splitLines(git(hookCase, repository, ['config', '--get-all', 'remote.origin.fetch']).stdout)
}

// Stop hook が読む .pecot/state/.auto-push-urls のパス。
function flagFilePath(hookCase: HookCase): string {
  return path.join(claudeProjectDirectory(hookCase), '.pecot', 'state', '.auto-push-urls')
}

function writeFlagFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

describe('auto-push.sh', () => {
  describe('正常系', () => {
    it('コミットが成功したとき、push を実行する', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(true)
    })

    it('push 先の WIP ブランチ名は wip/ を前置した名前になる', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(readText(setup.pushLog)).toContain('HEAD:refs/heads/wip/feat/add-auth/1443')
    })

    it('push には --no-verify と --force を付ける', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(readText(setup.pushLog)).toContain('--no-verify --force')
    })

    it('ssh のリモートで push に成功したとき、stdout は空でフラグファイルにだけ compare URL を書く', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      // additionalContext を廃止したので、成功時は stdout に何も出さない
      expect(result.stdout).toBe('')
      const flagFile = path.join(setup.stateDirectory, '.auto-push-urls')
      expect(existsSync(flagFile)).toBe(true)
      expect(readText(flagFile)).toContain('ghes.example.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443')
    })

    it('https のリモートで push に成功したとき、フラグファイルに compare URL を書く', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'https://github.com/testowner/testrepo.git')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      const flagFile = path.join(setup.stateDirectory, '.auto-push-urls')
      expect(existsSync(flagFile)).toBe(true)
      expect(readText(flagFile)).toContain('github.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443')
    })
  })

  describe('feature ブランチ以外', () => {
    it.for([
      { label: 'wt1', branch: 'wt1' },
      { label: 'develop-aist', branch: 'develop-aist' },
      { label: 'main', branch: 'main' },
    ])('ブランチが $label のとき、push しない', (row) => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, row.branch)
      const result = runAutoPush(hookCase, setup, commitSuccessJson(row.branch))
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(false)
    })
  })

  describe('エラー系', () => {
    it('push に失敗したとき、失敗の旨を stdout に出す', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      // push が失敗し、stderr にエラーを出す mock git に差し替える
      setup.mock.install('git', mockGitBody(setup.realGit, setup.pushLog, '1', 'fatal: could not read from remote repository'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('auto-push failed')
    })
  })

  describe('hooks-config.json による制御', () => {
    it('設定で auto-push を無効にしたとき、何も出力せず push しない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      setup.config.write({ 'auto-push': false })
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(setup.pushLog)).toBe(false)
    })
  })

  describe('コミット以外のコマンド', () => {
    it('git status のとき、何も出力せず push しない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const nonCommitJson = jsonDumps({
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'On branch feat/add-auth/1443', interrupted: false },
      })
      const result = runAutoPush(hookCase, setup, nonCommitJson)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(setup.pushLog)).toBe(false)
    })
  })

  describe('フラグファイルへの書き込み', () => {
    it('push に成功したとき、WIP ブランチ名と compare URL を書く', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      const flagFile = path.join(setup.stateDirectory, '.auto-push-urls')
      expect(existsSync(flagFile)).toBe(true)
      const content = readText(flagFile)
      expect(content).toContain('auto-push complete: wip/feat/add-auth/1443')
      expect(content).toContain('  compare: https://ghes.example.com/testowner/testrepo/compare/main...wip/feat/add-auth/1443')
    })

    it('コミットを重ねたとき、フラグファイルに追記する', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      runAutoPush(hookCase, setup)
      runAutoPush(hookCase, setup)
      const flagFile = path.join(setup.stateDirectory, '.auto-push-urls')
      expect(existsSync(flagFile)).toBe(true)
      // 2 エントリ分の auto-push complete が入る
      expect(readText(flagFile).split('auto-push complete').length - 1).toBe(2)
    })
  })

  describe('Stop hook の URL 表示', () => {
    it('フラグファイルがあるとき、systemMessage に push の結果と compare URL を出す', () => {
      const hookCase = createHookCase()
      writeFlagFile(
        flagFilePath(hookCase),
        'note: auto-push complete: wip/feat/test/123\n'
        + '  compare: https://ghes.example.com/owner/repo/compare/main...wip/feat/test/123\n'
        + '\n',
      )
      const result = runScript(hookCase, STOP_SCRIPT, [], { stdin: '' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"systemMessage"')
      expect(result.stdout).toContain('auto-push complete: wip/feat/test/123')
      expect(result.stdout).toContain('https://ghes.example.com/owner/repo/compare/main...wip/feat/test/123')
    })

    it('表示したあとに、フラグファイルを消す', () => {
      const hookCase = createHookCase()
      const flagFile = flagFilePath(hookCase)
      writeFlagFile(flagFile, 'note: auto-push complete: wip/feat/test/123\n  compare: https://example.com\n\n')
      const result = runScript(hookCase, STOP_SCRIPT, [], { stdin: '' })
      expect(result.exitCode).toBe(0)
      expect(existsSync(flagFile)).toBe(false)
    })

    it('フラグファイルが無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      // 書き込みをしないので、フラグファイルは作られない
      expect(existsSync(flagFilePath(hookCase))).toBe(false)
      const result = runScript(hookCase, STOP_SCRIPT, [], { stdin: '' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('URL が溜まっているとき、すべてを出力に含める', () => {
      const hookCase = createHookCase()
      writeFlagFile(
        flagFilePath(hookCase),
        'note: auto-push complete: wip/feat/a/1\n'
        + '  compare: https://ghes.example.com/o/r/compare/main...wip/feat/a/1\n'
        + '\n'
        + 'note: auto-push complete: wip/feat/b/2\n'
        + '  compare: https://ghes.example.com/o/r/compare/main...wip/feat/b/2\n'
        + '\n',
      )
      const result = runScript(hookCase, STOP_SCRIPT, [], { stdin: '' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('wip/feat/a/1')
      expect(result.stdout).toContain('wip/feat/b/2')
    })
  })

  describe('WIP ブランチと Issue のリンク', () => {
    it('初回の push では、GraphQL を 2 回呼び、リンク済みの WIP ブランチ名を記録する', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      // GraphQL は query と mutation の 2 回
      expect(existsSync(setup.graphqlLog)).toBe(true)
      const graphqlCalls = splitLines(readText(setup.graphqlLog)).filter(line => line.includes('graphql'))
      expect(graphqlCalls).toHaveLength(2)
      const linkedFile = path.join(setup.stateDirectory, '.wip-branch-linked')
      expect(existsSync(linkedFile)).toBe(true)
      expect(readText(linkedFile)).toBe('wip/feat/add-auth/1443')
    })

    it('同じブランチ名を記録済みのとき、2 回目の push ではリンクの API を呼ばない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      // 同一ブランチ名を事前に記録する
      writeFileSync(path.join(setup.stateDirectory, '.wip-branch-linked'), 'wip/feat/add-auth/1443')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      // API は呼ばれない
      expect(existsSync(setup.graphqlLog)).toBe(false)
      // push は実行される
      expect(existsSync(setup.pushLog)).toBe(true)
    })

    it('.pecot-active が無いとき、何も出力せず、push せず API も呼ばない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      rmSync(path.join(setup.stateDirectory, '.pecot-active'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(setup.pushLog)).toBe(false)
      expect(existsSync(setup.graphqlLog)).toBe(false)
    })

    it('リンクの API が失敗しても、push は成功し、記録は書かない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      // GraphQL の API を失敗させる（終了コードが 0 でない）
      setup.mock.install('gh', mockGhBody(setup.graphqlLog, '1'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      // push 自体は成功している（フラグファイルがある）
      expect(existsSync(path.join(setup.stateDirectory, '.auto-push-urls'))).toBe(true)
      // 次回やり直せるよう、記録は書かない
      expect(existsSync(path.join(setup.stateDirectory, '.wip-branch-linked'))).toBe(false)
    })

    it('mutation が linkedBranch=null を返したとき、成功扱いで記録を書く', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      // エラーなしで linkedBranch が null になる（既にリンク済みの場合）
      setup.mock.install('gh', mockGhBody(setup.graphqlLog, '0', '{"data":{"createLinkedBranch":{"linkedBranch":null}}}'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(true)
      // エラーが無いので、成功扱いで記録を書く
      const linkedFile = path.join(setup.stateDirectory, '.wip-branch-linked')
      expect(existsSync(linkedFile)).toBe(true)
      expect(readText(linkedFile)).toBe('wip/feat/add-auth/1443')
    })

    it('mutation が GraphQL エラーを返したとき、記録を書かない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      // 終了コードは 0 だが errors がある
      setup.mock.install('gh', mockGhBody(setup.graphqlLog, '0', '{"data":{"createLinkedBranch":null},"errors":[{"message":"Something went wrong"}]}'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(true)
      // 次回やり直せるよう、記録は書かない
      expect(existsSync(path.join(setup.stateDirectory, '.wip-branch-linked'))).toBe(false)
    })

    it('mutation が already exists のエラーを返したとき、やり直し不要として記録を書く', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/testrepo.git')
      writePecotActive(setup)
      setup.mock.install('gh', mockGhBody(setup.graphqlLog, '0', '{"data":{"createLinkedBranch":null},"errors":[{"message":"A branch with the name already exists"}]}'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(true)
      // やり直しは要らないので、記録を書く
      const linkedFile = path.join(setup.stateDirectory, '.wip-branch-linked')
      expect(existsSync(linkedFile)).toBe(true)
      expect(readText(linkedFile)).toBe('wip/feat/add-auth/1443')
    })
  })

  describe('対象の Issue とリポ', () => {
    it('.pecot-active が空のとき、何も出力せず、push せず API も呼ばない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      writeFileSync(path.join(setup.stateDirectory, '.pecot-active'), '')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(setup.pushLog)).toBe(false)
      expect(existsSync(setup.graphqlLog)).toBe(false)
    })

    it('.pecot-active の形式が不正なとき、push しない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      writeFileSync(path.join(setup.stateDirectory, '.pecot-active'), 'testowner/testrepo\n')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(false)
    })

    it('ブランチの Issue 番号が active と違うとき、push せず API も呼ばない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, 'feat/add-auth/999')
      const result = runAutoPush(hookCase, setup, commitSuccessJson('feat/add-auth/999'))
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(false)
      expect(existsSync(setup.graphqlLog)).toBe(false)
    })

    it('リモートが active のリポと違うとき、push せず API も呼ばない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, 'git@ghes.example.com:testowner/otherrepo.git')
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(false)
      expect(existsSync(setup.graphqlLog)).toBe(false)
    })

    it.for([
      { label: 'ssh://git@ghes.example.com:2222/testowner/testrepo.git', url: 'ssh://git@ghes.example.com:2222/testowner/testrepo.git', host: 'ghes.example.com' },
      { label: 'ssh://ghes.example.com/testowner/testrepo.git/', url: 'ssh://ghes.example.com/testowner/testrepo.git/', host: 'ghes.example.com' },
      { label: 'https://user:token@ghes.example.com/testowner/testrepo.git', url: 'https://user:token@ghes.example.com/testowner/testrepo.git', host: 'ghes.example.com' },
      { label: 'https://ghes.example.com/testowner/testrepo/', url: 'https://ghes.example.com/testowner/testrepo/', host: 'ghes.example.com' },
      { label: 'git@ghes.example.com:TestOwner/TestRepo.git', url: 'git@ghes.example.com:TestOwner/TestRepo.git', host: 'ghes.example.com' },
    ])('リモートの URL が $label のとき、push し、認証情報を含まない URL を書く', (row) => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setRemote(hookCase, setup, row.url)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(existsSync(setup.pushLog)).toBe(true)
      const flag = readText(path.join(setup.stateDirectory, '.auto-push-urls'))
      expect(flag).toContain(`https://${row.host}/`)
      expect(flag).not.toContain('token')
    })
  })

  describe('追跡 ref の削除と除外の refspec', () => {
    it('push の後に、wip の追跡 ref を残さない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(listWipTrackingReferences(hookCase, setup.repository)).toBe('')
    })

    it('push に失敗しても、wip の追跡 ref を残さない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      gitOrThrow(hookCase, setup.repository, ['update-ref', 'refs/remotes/origin/wip/old/1', 'HEAD'])
      setup.mock.install('git', mockGitBody(setup.realGit, setup.pushLog, '1', 'fatal: x'))
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('auto-push failed')
      expect(listWipTrackingReferences(hookCase, setup.repository)).toBe('')
    })

    it('2 回動かしても、除外の refspec は 1 件だけ足す', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      gitOrThrow(hookCase, setup.repository, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
      const results = [runAutoPush(hookCase, setup), runAutoPush(hookCase, setup)]
      expect(results.map(result => result.exitCode)).toEqual([0, 0])
      const specs = fetchRefspecs(hookCase, setup.repository)
      expect(specs.filter(spec => spec === '^refs/heads/wip/*')).toHaveLength(1)
      expect(specs).toContain('+refs/heads/*:refs/remotes/origin/*')
    })

    it('取得の refspec が無いとき、除外の refspec は足さない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      gitOrThrow(hookCase, setup.repository, ['config', '--unset-all', 'remote.origin.fetch'])
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      expect(fetchRefspecs(hookCase, setup.repository)).not.toContain('^refs/heads/wip/*')
    })

    it('mock git を使わず実際に push しても、追跡 ref が残らない', () => {
      const hookCase = createHookCase()
      const setup = setUpEnvironment(hookCase)
      const bare = path.join(hookCase.temporaryPath, 'bare.git')
      const init = run(hookCase, 'git', ['init', '--bare', '--quiet', bare])
      expect(init.exitCode).toBe(0)
      gitOrThrow(hookCase, setup.repository, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
      gitOrThrow(hookCase, setup.repository, ['config', `url.${bare}.pushInsteadOf`, DEFAULT_ORIGIN])
      checkout(hookCase, setup, DEFAULT_BRANCH_NAME)
      setup.mock.install('git', `#!/bin/bash\nexec ${JSON.stringify(setup.realGit)} "$@"\n`)
      const result = runAutoPush(hookCase, setup)
      expect(result.exitCode).toBe(0)
      const remoteReferences = gitOrThrow(hookCase, bare, ['for-each-ref', 'refs/heads/wip/'])
      expect(remoteReferences).toContain('refs/heads/wip/feat/add-auth/1443')
      expect(listWipTrackingReferences(hookCase, setup.repository)).toBe('')
      gitOrThrow(hookCase, setup.repository, ['-c', `url.${bare}.insteadOf=${DEFAULT_ORIGIN}`, 'fetch', 'origin'])
      expect(listWipTrackingReferences(hookCase, setup.repository)).toBe('')
    })
  })
})
