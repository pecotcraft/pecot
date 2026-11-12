/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// PROJECT_ROOT とは別パスのリポジトリで、フックが正しく動くことのテスト。
// -C フラグ・cd チェイン・pwd フォールバックの各手段で、WIP push と比較 URL の書き込み先を見る。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase, HooksConfig } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository } from '../_helpers/git.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { runPostScript, runShell } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const autoPushScript = path.join(hooksDirectory, 'lib', 'post-tool-use', 'auto-push.sh')
const commitInfoScript = path.join(hooksDirectory, 'lib', 'post-tool-use', 'commit-info-display.sh')

const BRANCH = 'feat/cross-repo-test/999'
const WIP_REF = 'HEAD:refs/heads/wip/feat/cross-repo-test/999'
const COMPARE_URL = 'github.com/otherorg/otherrepo/compare/main...wip/feat/cross-repo-test/999'
const SSH_REMOTE = 'git@github.com:otherorg/otherrepo.git'

// push を記録し、それ以外は実 git へ exec する mock git の本体。
function mockGitBody(realGit: string, pushLog: string): string {
  return `#!/bin/bash
REAL_GIT=${jsonDumps(realGit)}
PUSH_LOG=${jsonDumps(pushLog)}
PUSH_EXIT=${jsonDumps('0')}
cmd="$1"
if [ "$1" = "-C" ]; then
    cmd="$3"
fi
if [ "$cmd" = "push" ]; then
    echo "$@" > "$PUSH_LOG"
    exit "$PUSH_EXIT"
fi
exec "$REAL_GIT" "$@"
`
}

// デフォルトブランチの取得に応える mock gh の本体。
function mockGhBody(defaultBranch = 'main'): string {
  return `#!/bin/bash
if [ "$1" = "api" ]; then
    echo ${jsonDumps(defaultBranch)}
    exit 0
fi
exit 1
`
}

interface CommitJsonOptions {
  readonly repositoryDirectory?: string
  readonly branch?: string
}

// コミット成功の PostToolUse JSON。repositoryDirectory を渡すと command に git -C <dir> commit を埋め込む。
function commitSuccessPayload(options: CommitJsonOptions = {}): Record<string, unknown> {
  const branch = options.branch ?? BRANCH
  const flag = options.repositoryDirectory === undefined ? '' : `-C ${options.repositoryDirectory} `
  return {
    tool_input: { command: `git ${flag}commit -m "feat: cross repo change"` },
    tool_response: {
      stdout: `[${branch} abc1234] feat: cross repo change\n 1 file changed, 1 insertion(+)`,
      interrupted: false,
    },
  }
}

// cd <dir><separator> git commit ... 形のコミット成功 JSON
function cdChainJson(repositoryDirectory: string, separator: string): string {
  return jsonDumps({
    tool_input: { command: `cd ${repositoryDirectory}${separator} git commit -m "feat: cd chain test"` },
    tool_response: {
      stdout: '[feat/cross-repo-test/999 abc1234] feat: cd chain test\n 1 file changed, 1 insertion(+)',
      interrupted: false,
    },
  })
}

interface CrossRepositoryEnvironment {
  readonly config: HooksConfig
  readonly project: string
  readonly crossRepository: string
  readonly pushLog: string
  readonly flagFile: string
}

// auto-push を有効にし、別リポジトリと mock の git・gh を用意する。
// auto-push は pecot 管理のリポジトリでだけ動き、pecot_state_dir_ensure が .pecot の存在を要求するため、.pecot も作る。
function setUpCrossRepository(hookCase: HookCase): CrossRepositoryEnvironment {
  const bin = mockBin(hookCase)
  const realGit = runShell(hookCase, 'command -v git').stdout.trim() || 'git'
  const pushLog = path.join(hookCase.temporaryPath, 'mock-git-push.log')
  const config = hooksConfig(hookCase)
  config.write({ 'auto-push': true })

  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(path.join(project, 'tmp'), { recursive: true })
  mkdirSync(path.join(project, '.pecot'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)

  // PROJECT_ROOT とは異なるパスの別リポジトリ
  const crossRepository = gitRepository(hookCase, 'cross-repo')
  gitOrThrow(hookCase, crossRepository, ['remote', 'add', 'origin', SSH_REMOTE])
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(path.join(stateDirectory, '.pecot-active'), 'otherorg/otherrepo/999\n')

  bin.install('git', mockGitBody(realGit, pushLog))
  bin.install('gh', mockGhBody())

  return { config, project, crossRepository, pushLog, flagFile: path.join(stateDirectory, '.auto-push-urls') }
}

function checkout(hookCase: HookCase, repositoryDirectory: string, branch: string): void {
  gitOrThrow(hookCase, repositoryDirectory, ['checkout', '-b', branch])
}

function setRemote(hookCase: HookCase, repositoryDirectory: string, url: string): void {
  gitOrThrow(hookCase, repositoryDirectory, ['remote', 'set-url', 'origin', url])
}

function runPost(hookCase: HookCase, script: string, json: string, cwd?: string): RunResult {
  return runPostScript(hookCase, script, json, cwd === undefined ? {} : { cwd })
}

describe('cross-repo', () => {
  it('別リポジトリの feature ブランチで commit するとき、push を実行する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)

    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload()), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(existsSync(environment.pushLog)).toBe(true)
  })

  it('別リポジトリのブランチ名から、WIP ブランチ名を組み立てる', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)

    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload()), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(readFileSync(environment.pushLog, 'utf8')).toContain(WIP_REF)
  })

  it('remote が SSH 形式のとき、比較 URL を書き込む', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)

    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload()), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(environment.flagFile)).toBe(true)
    expect(readFileSync(environment.flagFile, 'utf8')).toContain(COMPARE_URL)
  })

  it('remote が HTTPS 形式のとき、比較 URL を書き込む', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, 'https://github.com/otherorg/otherrepo.git')

    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload()), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(environment.flagFile)).toBe(true)
    expect(readFileSync(environment.flagFile, 'utf8')).toContain(COMPARE_URL)
  })

  it('git -C でリポジトリを指定するとき、cwd がそこに無くても正しいリポジトリへ push する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)

    // cd せずに -C フラグでリポジトリを指定する（cwd はリポジトリに置かない）。
    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload({ repositoryDirectory: environment.crossRepository })))

    expect(result.exitCode).toBe(0)
    expect(existsSync(environment.pushLog)).toBe(true)
    expect(readFileSync(environment.pushLog, 'utf8')).toContain(WIP_REF)
  })

  it('git -C でリポジトリを指定するとき、比較 URL を書き込む', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)

    const result = runPost(hookCase, autoPushScript, jsonDumps(commitSuccessPayload({ repositoryDirectory: environment.crossRepository })))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(environment.flagFile)).toBe(true)
    expect(readFileSync(environment.flagFile, 'utf8')).toContain(COMPARE_URL)
  })

  it('git -C でリポジトリを指定するとき、commit-info-display は別リポジトリのコミットを表示する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    // commit-info-display を有効にする
    environment.config.write({ 'commit-info-display': true })
    checkout(hookCase, environment.crossRepository, BRANCH)

    const result = runPost(hookCase, commitInfoScript, jsonDumps(commitSuccessPayload({ repositoryDirectory: environment.crossRepository })))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: commit complete')
    // 別リポジトリのコミットメッセージ（initial commit）が表示される。
    expect(result.stdout).toContain('initial commit')
  })

  it.for([
    { label: '&&', separator: ' &&' },
    { label: ';', separator: ';' },
  ])('cd チェインの区切りが $label のとき、cd 先のリポジトリへ push する', (row) => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)

    const result = runPost(hookCase, autoPushScript, cdChainJson(environment.crossRepository, row.separator), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(existsSync(environment.pushLog)).toBe(true)
    expect(readFileSync(environment.pushLog, 'utf8')).toContain(WIP_REF)
  })

  it('コマンドが -C と cd チェインのどちらも持たないとき、pwd のリポジトリへ push する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)

    // -C と cd チェインのどちらも無いコマンド（pwd が cross-repo になる）。
    const pwdJson = jsonDumps({
      tool_input: { command: 'git commit -m "feat: pwd fallback test"' },
      tool_response: {
        stdout: '[feat/cross-repo-test/999 abc1234] feat: pwd fallback test\n 1 file changed, 1 insertion(+)',
        interrupted: false,
      },
    })

    const result = runPost(hookCase, autoPushScript, pwdJson, environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(existsSync(environment.pushLog)).toBe(true)
    expect(readFileSync(environment.pushLog, 'utf8')).toContain(WIP_REF)
  })

  // 入力 JSON の cwd（resolver の優先 3）は pwd より優先される。env を立てず、実際と同じく入力 JSON で cwd を渡す。
  it('入力 JSON に cwd があるとき、pwd より優先してそのリポジトリへ push する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    checkout(hookCase, environment.crossRepository, BRANCH)
    setRemote(hookCase, environment.crossRepository, SSH_REMOTE)
    // pwd 側は別リポジトリ・別ブランチにする。
    // 選ばれたのが入力 JSON の cwd 側であることは、push 先のブランチ名で見分ける。
    const other = gitRepository(hookCase, 'pwd-side')
    checkout(hookCase, other, 'feat/pwd-side/000')
    const payload = { ...commitSuccessPayload(), cwd: environment.crossRepository }

    const result = runPost(hookCase, autoPushScript, jsonDumps(payload), other)

    expect(result.exitCode).toBe(0)
    expect(existsSync(environment.pushLog)).toBe(true)
    expect(readFileSync(environment.pushLog, 'utf8')).toContain(WIP_REF)
  })

  it('cd チェインで commit するとき、commit-info-display は cd 先のコミットを表示する', () => {
    const hookCase = createHookCase()
    const environment = setUpCrossRepository(hookCase)
    environment.config.write({ 'commit-info-display': true })
    checkout(hookCase, environment.crossRepository, BRANCH)

    const result = runPost(hookCase, commitInfoScript, cdChainJson(environment.crossRepository, ' &&'), environment.crossRepository)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: commit complete')
    expect(result.stdout).toContain('initial commit')
  })
})
