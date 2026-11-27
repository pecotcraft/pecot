/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-title.sh（Claude Code のセッション名）のテスト。
// 番号はブランチ名と remote から求め、題名は .pecot-session-title から取る。session-title-sent の `<session_id>:<題名>` と違うときだけ出す。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { checkoutWorkBranch, gitOrThrow, gitRepository } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { parseJson } from '../_helpers/text.js'
import { readOutput } from '../../../../../../libs/interface-spec/src/vitest/attach.js'
import { explains } from '../../_helpers/explains.js'

const SCRIPT = path.join(coreDirectory, 'session-title.sh')

interface Project {
  readonly project: string
  readonly state: string
}

// .pecot/state を持つ git のリポを CLAUDE_PROJECT_DIR に向ける。
function setUpState(hookCase: HookCase): Project {
  const project = gitRepository(hookCase, 'project')
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  writeFileSync(path.join(project, '.pecot', '.gitignore'), '*\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return { project, state }
}

interface RunOptions {
  readonly event?: string
  readonly sessionId?: string
  readonly source?: string
  readonly currentTitle?: string
}

function runSessionTitle(hookCase: HookCase, options: RunOptions = {}): RunResult {
  return runScript(hookCase, SCRIPT, [], {
    stdin: '{}',
    env: {
      PECOT_HOOK_EVENT: options.event ?? 'UserPromptSubmit',
      PECOT_HOOK_SESSION_ID: options.sessionId ?? 's1',
      PECOT_HOOK_SOURCE: options.source ?? '',
      PECOT_HOOK_SESSION_TITLE: options.currentTitle ?? '',
      PECOT_HOOK_TRANSCRIPT_PATH: '/t/s.jsonl',
    },
  })
}

// 出力の hookSpecificOutput.sessionTitle を取り出す。
function titleOf(result: RunResult): unknown {
  const output = parseJson(result.stdout)
  if (typeof output !== 'object' || output === null) return undefined
  const specific: unknown = Reflect.get(output, 'hookSpecificOutput')
  return typeof specific !== 'object' || specific === null ? undefined : Reflect.get(specific, 'sessionTitle')
}

function writeTitle(state: string, title: string): void {
  writeFileSync(path.join(state, '.pecot-session-title'), `${title}\n`)
}

function activate(hookCase: HookCase, { project, state }: Project, branch = 'feat/x/1', title = '#1 a'): void {
  checkoutWorkBranch(hookCase, project, branch)
  writeTitle(state, title)
}

function readSent(state: string): string {
  return readOutput(path.join(state, 'session-title-sent'))
}

// 出さなかったときの期待は { exitCode: 0, stdout: '', sent: false }。
function outcomeOf(result: RunResult, state: string): { exitCode: number | null, stdout: string, sent: boolean } {
  return { exitCode: result.exitCode, stdout: result.stdout, sent: existsSync(path.join(state, 'session-title-sent')) }
}

const SILENT = { exitCode: 0, stdout: '', sent: false }

describe('session-title.sh', () => {
  it('作業中の Issue が無い（ブランチの末尾が番号でない）とき、何も出力せず、記録を残さない', async () => {
    await explains('`session-title.sh`（セッション名を出すスクリプト）のテストです。ブランチの末尾が番号でなく作業中の Issue が無い場合に、何も出力せず、送った名前の記録も残さないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    checkoutWorkBranch(hookCase, project.project, 'main')
    writeTitle(project.state, '#1 a')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('ブランチと remote から求めた番号と題名でセッション名を出し、送った名前を記録する', async () => {
    await explains('`session-title.sh` のテストです。ブランチと remote から番号が求まり、題名のファイルがある場合に、`#1253 題名` をセッション名として出力し、送った名前を記録することを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project, 'feat/x/1253', '#1253 題名')
    const result = runSessionTitle(hookCase, { event: 'SessionStart', source: 'startup' })
    expect(parseJson(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: '#1253 題名' },
    })
    expect(readSent(project.state)).toBe('s1:#1253 題名\n')
  })

  it('別の番号の .pecot-active を置いても読まず、ブランチの番号を使う', async () => {
    await explains('`session-title.sh` のテストです。別の番号の `.pecot-active` が置かれている場合でも、それを読まずに、ブランチの番号を使ってセッション名を出すことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project, 'feat/x/7', '#7 題名')
    writeFileSync(path.join(project.state, '.pecot-active'), 'owner/repo/1\n')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#7 題名')
  })

  it('ブランチが番号でなければ、.pecot-active があっても出さない', async () => {
    await explains('`session-title.sh` のテストです。ブランチが番号でない場合は、`.pecot-active` が置かれていても、何も出力せず、記録も残さないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    checkoutWorkBranch(hookCase, project.project, 'main')
    writeFileSync(path.join(project.state, '.pecot-active'), 'owner/repo/1\n')
    writeTitle(project.state, '#1 a')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it.for([
    { label: 'https', url: 'https://github.com/owner/repo.git' },
    { label: 'https の .git 無し', url: 'https://github.com/owner/repo' },
    { label: 'scp 形の ssh', url: 'git@github.com:owner/repo.git' },
    { label: 'ssh://', url: 'ssh://git@github.com:22/owner/repo.git' },
    { label: 'git://', url: 'git://github.com/owner/repo.git' },
    { label: 'git 以外のユーザーの scp 形', url: 'user@github.com:owner/repo.git' },
    { label: '別名の scp 形', url: 'gh-alias:owner/repo.git' },
    { label: 'コロンの直後に / がある scp 形', url: 'git@github.com:/owner/repo.git' },
    { label: 'https で末尾に /', url: 'https://github.com/owner/repo/' },
  ])('remote の URL が $label の形なら、番号を出す', async (row) => {
    await explains(`\`session-title.sh\` のテストです。remote の URL が ${row.label} の形の場合に、URL から owner と repo を読み取り、ブランチの番号（\`#3\`）をセッション名として出力することを確認します。`)
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    checkoutWorkBranch(hookCase, project.project, 'feat/x/3', row.url)
    expect(titleOf(runSessionTitle(hookCase))).toBe('#3')
  })

  it.for<{ label: string, url: string | false }>([
    { label: 'remote が無い', url: false },
    { label: 'ローカルのパス', url: '/srv/git/repo.git' },
    { label: 'https で区切りが足りない', url: 'https://github.com/repo' },
    { label: 'ftp:// で区切りが足りない', url: 'ftp://o/r' },
    { label: 'owner に % を含む https', url: 'https://github.com/own%20er/repo.git' },
    { label: 'repo に空白を含む scp 形の ssh', url: 'git@github.com:owner/re po.git' },
    { label: 'owner に @ を含む ssh://', url: 'ssh://git@github.com/own@er/repo.git' },
    { label: '~user の scp 形', url: 'git@github.com:~user/repo.git' },
    { label: 'ドライブ文字で始まるパス', url: 'C:/owner/repo.git' },
  ])('$label とき、作業中の Issue は無いとして、出力せず記録を残さない', async (row) => {
    await explains(`\`session-title.sh\` のテストです。remote の URL が ${row.label} の場合に、作業中の Issue は無いと判断し、何も出力せず、記録も残さないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    checkoutWorkBranch(hookCase, project.project, 'feat/x/1', row.url)
    writeTitle(project.state, '#1 a')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('origin が無ければ、最初の remote の URL で判定する', async () => {
    await explains('`session-title.sh` のテストです。`origin` が無く remote が複数ある場合に、最初の remote の URL で判定し、ブランチの番号（`#4`）を出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    gitOrThrow(hookCase, project.project, ['remote', 'add', 'aaa', 'https://github.com/owner/repo.git'])
    gitOrThrow(hookCase, project.project, ['remote', 'add', 'zzz', '/srv/git/repo.git'])
    checkoutWorkBranch(hookCase, project.project, 'feat/x/4', false)
    expect(titleOf(runSessionTitle(hookCase))).toBe('#4')
  })

  it('origin があれば、ほかの remote の URL では判定しない', async () => {
    await explains('`session-title.sh` のテストです。`origin` がある場合に、ほかの remote の URL では判定せず、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    gitOrThrow(hookCase, project.project, ['remote', 'add', 'aaa', 'https://github.com/owner/repo.git'])
    checkoutWorkBranch(hookCase, project.project, 'feat/x/4', '/srv/git/repo.git')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('detached HEAD のとき、出力しない', async () => {
    await explains('`session-title.sh` のテストです。detached HEAD の状態で実行した場合に、ブランチが無いため、何も出力せず、記録も残さないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    gitOrThrow(hookCase, project.project, ['checkout', '-q', '--detach'])
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('番号が 0 のブランチ（feat/x/0）では、出力しない', async () => {
    await explains('`session-title.sh` のテストです。番号が 0 のブランチ（`feat/x/0`）で実行した場合に、Issue の番号として扱わず、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project, 'feat/x/0', '#0 a')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('先頭に 0 のある番号（feat/x/007）は、0 を落として 7 にする', async () => {
    await explains('`session-title.sh` のテストです。先頭に 0 のある番号のブランチ（`feat/x/007`）で実行した場合に、0 を落として `#7` として扱い、題名を出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project, 'feat/x/007', '#7 題名')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#7 題名')
  })

  it('題名のファイルが無いとき、番号だけにする', async () => {
    await explains('`session-title.sh` のテストです。題名のファイルが存在しない場合に、番号だけの `#1253` をセッション名として出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    checkoutWorkBranch(hookCase, project.project, 'feat/x/1253')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1253')
  })

  it('同じセッションでは、同じ題名を再送しない', async () => {
    await explains('`session-title.sh` のテストです。同じセッションで続けて 2 回実行した場合に、1 回目だけ題名を出力し、2 回目は何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1 a')
    const second = runSessionTitle(hookCase)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe('')
  })

  it('題名が変わったとき、またはセッションが違うとき、再送する', async () => {
    await explains('`session-title.sh` のテストです。セッションが変わった場合と、Issue が切り替わって題名が変わった場合に、同じ題名でも再び出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    runSessionTitle(hookCase)
    // 別セッション（/clear 後や新規起動）には同じ題名でも出す
    expect(titleOf(runSessionTitle(hookCase, { sessionId: 's2' }))).toBe('#1 a')
    // Issue が切り替わったら同じセッションでも出す
    gitOrThrow(hookCase, project.project, ['checkout', '-q', '-b', 'feat/x/2'])
    writeTitle(project.state, '#2 b')
    expect(titleOf(runSessionTitle(hookCase, { sessionId: 's2' }))).toBe('#2 b')
  })

  it('hooks-config で無効にしたとき、何も出力しない', async () => {
    await explains('`session-title.sh` のテストです。`hooks-config` で `session-title` を無効にした場合は、終了コード 0 で終了し、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    hooksConfig(hookCase).write({ 'session-title': false })
    activate(hookCase, project)
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('.pecot の無いリポでは、何も書かず、出力もしない', async () => {
    // pecot 未使用のリポ
    await explains('`session-title.sh` のテストです。`.pecot` ディレクトリが無い pecot 未使用のリポで実行した場合に、何も出力せず、`.pecot` も作らないことを確認します。')
    const hookCase = createHookCase()
    const project = gitRepository(hookCase, 'plain')
    checkoutWorkBranch(hookCase, project, 'feat/x/1')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
    const result = runSessionTitle(hookCase)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
  })

  it.for([
    { label: 'startup', source: 'startup' },
    { label: 'resume', source: 'resume' },
    { label: 'fork', source: 'fork' },
  ])('SessionStart の source が $label のとき、セッション名を出す', async (row) => {
    await explains(`\`session-title.sh\` のテストです。\`SessionStart\` の \`source\` が \`${row.source}\` の場合に、\`#1 a\` をセッション名として出力することを確認します。`)
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase))
    const result = runSessionTitle(hookCase, { event: 'SessionStart', source: row.source })
    expect(titleOf(result)).toBe('#1 a')
  })

  it.for([
    { label: 'clear', source: 'clear' },
    { label: 'compact', source: 'compact' },
    { label: 'new', source: 'new' },
    { label: '空文字', source: '' },
  ])('SessionStart の source が $label のとき、出力せず、記録を残さない', async (row) => {
    // sessionTitle が適用されない source では出さず、sent にも残さない（次の機会に出せる）
    await explains(`\`session-title.sh\` のテストです。\`SessionStart\` の \`source\` が ${row.label} の場合に、セッション名が適用されないため、何も出力せず、記録も残さないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    expect(outcomeOf(runSessionTitle(hookCase, { event: 'SessionStart', source: row.source }), project.state)).toEqual(SILENT)
  })

  it('transcript_path が無いとき（Copilot CLI）、出力せず、記録を残さない', async () => {
    await explains('`session-title.sh` のテストです。Copilot CLI のように `transcript_path` が無い入力の場合に、何も出力せず、送った名前の記録も残さないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    const result = runScript(hookCase, SCRIPT, [], {
      stdin: '{}',
      env: { PECOT_HOOK_EVENT: 'SessionStart', PECOT_HOOK_SOURCE: 'new' },
    })
    expect(outcomeOf(result, project.state)).toEqual(SILENT)
  })

  it('入力の session_title が同じ名前のとき、出力せず、記録を残さない', async () => {
    // 既に同じ名前が付いているセッション
    await explains('`session-title.sh` のテストです。入力の `session_title` が出力する名前と同じ場合に、すでに付いた名前なので、何も出力せず、記録も残さないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    expect(outcomeOf(runSessionTitle(hookCase, { currentTitle: '#1 a' }), project.state)).toEqual(SILENT)
  })

  it('session_id が空でも、記録して再送しない', async () => {
    await explains('`session-title.sh` のテストです。`session_id` が空の場合でも、題名を記録し、同じ入力で再び実行しても再送しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project)
    expect(titleOf(runSessionTitle(hookCase, { sessionId: '' }))).toBe('#1 a')
    expect(readSent(project.state)).toBe(':#1 a\n')
    expect(runSessionTitle(hookCase, { sessionId: '' }).stdout).toBe('')
  })

  it('送った後に利用者が /rename した名前は、上書きしない', async () => {
    // 入力の session_title が違う場合
    await explains('`session-title.sh` のテストです。送った後に利用者が `/rename` で名前を変えた場合に、その名前を上書きせず、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase))
    runSessionTitle(hookCase)
    expect(runSessionTitle(hookCase, { currentTitle: 'my own name' }).stdout).toBe('')
  })

  it.for([
    { label: 'feat/x/387a', branch: 'feat/x/387a' },
    { label: 'feat/387/x', branch: 'feat/387/x' },
    { label: '025-hook-session-state', branch: '025-hook-session-state' },
  ])('ブランチの末尾の区切りが数字だけでない（$label）とき、出力せず記録を残さない', async (row) => {
    await explains(`\`session-title.sh\` のテストです。ブランチの末尾の区切りが数字だけでない（${row.label}）場合に、Issue の番号として扱わず、何も出力しないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpState(hookCase)
    activate(hookCase, project, row.branch, '#1 a')
    expect(outcomeOf(runSessionTitle(hookCase), project.state)).toEqual(SILENT)
  })

  it('題名が別の Issue のものだったとき、番号だけにする', async () => {
    await explains('`session-title.sh` のテストです。題名のファイルが別の Issue（`#99`）のものだった場合に、その題名を使わず、番号だけの `#5` を出力することを確認します。')
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase), 'feat/x/5', '#99 x')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#5')
  })

  it('番号が前方一致するだけの題名は、採用しない', async () => {
    // #12 の題名は #1 の題名として採用しない
    await explains('`session-title.sh` のテストです。題名の番号が前方一致するだけ（`#12` と `#1`）の場合に、その題名を採用せず、番号だけの `#1` を出力することを確認します。')
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase), 'feat/x/1', '#12 x')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#1')
  })

  it('題名が番号と等しいとき、採用する', async () => {
    await explains('`session-title.sh` のテストです。題名のファイルの中身が番号だけ（`#7`）と等しい場合に、その内容を採用して `#7` を出力することを確認します。')
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase), 'feat/x/7', '#7')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#7')
  })

  it('題名のファイルが空のとき、番号だけにする', async () => {
    await explains('`session-title.sh` のテストです。題名のファイルが空の場合に、番号だけの `#5` をセッション名として出力することを確認します。')
    const hookCase = createHookCase()
    activate(hookCase, setUpState(hookCase), 'feat/x/5', '')
    expect(titleOf(runSessionTitle(hookCase))).toBe('#5')
  })
})
