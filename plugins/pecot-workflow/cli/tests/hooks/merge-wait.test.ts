// skills/w-merge/scripts/merge-wait.sh のテスト。判定の表は source して merge_wait_decide に語を与えて確かめる。
// ループは偽の gh（fixtures/merge-wait/fake-gh.sh）を PATH の先頭に置いて動かす。
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { mockBin } from './_helpers/mock-bin.js'
import { pluginRoot } from './_helpers/paths.js'
import { run, runScript, runShell } from './_helpers/run.js'
import { splitLines } from './_helpers/text.js'

/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは fixture と一時ディレクトリだけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 補助は fixture を組み替える */

const SCRIPT = path.join(pluginRoot, 'skills', 'w-merge', 'scripts', 'merge-wait.sh')
const SKILL = path.join(pluginRoot, 'skills', 'w-merge', 'SKILL.md')
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'merge-wait')
const TARGET = 'pecotcraft/pecot/361'

interface Check {
  name?: string
  context?: string
  conclusion?: string | undefined
  status?: string
  state?: string
  isRequired: boolean
}

interface CountByState {
  state: string
  count: number
}

interface Contexts {
  nodes: Check[]
  checkRunCount: number
  statusContextCount: number
  checkRunCountsByState: CountByState[]
  statusContextCountsByState: CountByState[]
}

interface PullRequest {
  state: string
  isInMergeQueue: boolean
  autoMergeRequest: { enabledAt: string } | undefined
  mergeable: string
  mergeStateStatus: string
  commits: { nodes: { commit: { statusCheckRollup?: { contexts: Contexts } | undefined } }[] }
}

interface PrResponse {
  data: { repository: { pullRequest: PullRequest | undefined } }
}

interface ErrorResponse {
  __error__: string
}

type Response = PrResponse | ErrorResponse

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'))
}

function load(name: string): PrResponse {
  // eslint-disable-next-line no-restricted-syntax -- JSON の fixture を型に絞る
  return readFixture(`pr_${name}.json`) as PrResponse
}

interface RuleEntry {
  type: string
}

// eslint-disable-next-line no-restricted-syntax -- JSON の fixture を型に絞る
const rulesMain = (): RuleEntry[] => readFixture('rules_main.json') as RuleEntry[]
// eslint-disable-next-line no-restricted-syntax -- JSON の fixture を型に絞る
const alertsMain = (): unknown[] => readFixture('code_scanning_alerts.json') as unknown[]

interface VariantOptions {
  state?: string
  queue?: boolean
  auto?: boolean
  mergeable?: string
  mss?: string
  contexts?: Check[]
  noRollup?: boolean
}

function pullRequestOf(response: PrResponse): PullRequest {
  const pr = response.data.repository.pullRequest
  if (pr === undefined) throw new TypeError('pullRequest がありません')
  return pr
}

function contextsOf(response: PrResponse): Contexts {
  const rollup = pullRequestOf(response).commits.nodes[0]?.commit.statusCheckRollup
  if (!rollup) throw new TypeError('statusCheckRollup がありません')
  return rollup.contexts
}

// fixture を元にして、判定が読む欄だけ差し替える。contexts を替えたら件数の欄も揃える。
function variant(base: string, options: VariantOptions = {}): PrResponse {
  const data = structuredClone(load(base))
  const pr = pullRequestOf(data)
  if (options.state !== undefined) pr.state = options.state
  if (options.queue !== undefined) pr.isInMergeQueue = options.queue
  if (options.auto !== undefined) pr.autoMergeRequest = options.auto ? { enabledAt: '2026-11-10T00:00:00Z' } : undefined
  if (options.mergeable !== undefined) pr.mergeable = options.mergeable
  if (options.mss !== undefined) pr.mergeStateStatus = options.mss
  if (options.contexts !== undefined) {
    const rollup = contextsOf(data)
    const checkRuns = options.contexts.filter(c => c.context === undefined)
    const statuses = options.contexts.filter(c => c.context !== undefined)
    rollup.nodes = options.contexts
    rollup.checkRunCount = checkRuns.length
    rollup.statusContextCount = statuses.length
    for (const entry of rollup.checkRunCountsByState) entry.count = checkRuns.filter(c => (c.conclusion ?? c.status) === entry.state).length
    for (const entry of rollup.statusContextCountsByState) entry.count = statuses.filter(c => c.state === entry.state).length
  }
  if (options.noRollup) {
    const commit = pr.commits.nodes[0]?.commit
    if (commit) commit.statusCheckRollup = undefined
  }
  return data
}

const runCheck = (name: string, conclusion = 'SUCCESS', isRequired = true): Check => ({ name, conclusion, status: 'COMPLETED', isRequired })
const runPending = (name: string, isRequired = true, status = 'IN_PROGRESS'): Check => ({ name, conclusion: undefined, status, isRequired })
const contextStatus = (name: string, state: string, isRequired = true): Check => ({ context: name, state, isRequired })

const PASSED = [runCheck('ci-result'), runCheck('version-plan')]
const MERGED = load('265')
const BLOCKED_BY_RULESET = variant('262', { auto: true, mss: 'BLOCKED', contexts: PASSED })
const UNREPORTED_RUNNING = variant('262', { auto: true, contexts: [runPending('ci-result')] })

interface RunOptions {
  rules?: unknown
  alerts?: unknown
  rulesFailures?: number
  defaultArguments?: string[]
}

interface Runner {
  exec(responses: Response[], extraArguments?: string[], options?: RunOptions): ReturnType<typeof run>
  calls(): string[]
}

// 偽の gh を置き、応答のファイルを用意して merge-wait.sh を起動する runner を返す。
function makeRunner(hookCase: HookCase): Runner {
  const base = path.join(hookCase.temporaryPath, 'fake')
  mkdirSync(path.join(base, 'queue'), { recursive: true })
  hookCase.setEnv('FAKE_GH_BASE', base)
  mockBin(hookCase).install('gh', readFileSync(path.join(FIXTURES, 'fake-gh.sh'), 'utf8'))
  return {
    exec(responses, extraArguments = [], options = {}) {
      for (const [index, response] of responses.entries()) writeFileSync(path.join(base, 'queue', `${String(index + 1)}.json`), JSON.stringify(response))
      writeFileSync(path.join(base, 'rules.json'), JSON.stringify(options.rules ?? rulesMain()))
      writeFileSync(path.join(base, 'alerts.json'), JSON.stringify(options.alerts ?? alertsMain()))
      writeFileSync(path.join(base, 'rules_failures'), String(options.rulesFailures ?? 0))
      const defaultArguments = options.defaultArguments ?? ['--interval', '0', '--settle-seconds', '0']
      return runScript(hookCase, SCRIPT, [TARGET, ...defaultArguments, ...extraArguments])
    },
    calls() {
      try {
        return readFileSync(path.join(base, 'calls'), 'utf8').split(/\s+/u).filter(Boolean)
      }
      catch {
        return []
      }
    },
  }
}

function setup(): Runner {
  return makeRunner(createHookCase())
}

function decide(words: readonly string[]): string {
  const hookCase = createHookCase()
  const result = runShell(hookCase, `source "${SCRIPT}"; merge_wait_decide "$@"`, words)
  expect(result.exitCode).toBe(0)
  return result.stdout.trim()
}

const countOf = (calls: readonly string[], kind: string): number => calls.filter(c => c === kind).length

describe('merge-wait.sh の判定の表', () => {
  // 引数: state in_queue auto_merge mergeable required_failed checks_running mergeStateStatus
  const rows = [
    { name: '1-merged', words: ['MERGED', 'false', 'false', 'UNKNOWN', 'false', 'false', 'UNKNOWN'], expected: 'exit:merged' },
    { name: '2-closed', words: ['CLOSED', 'false', 'false', 'UNKNOWN', 'false', 'false', 'UNKNOWN'], expected: 'exit:closed' },
    { name: '3-conflicting', words: ['OPEN', 'false', 'true', 'CONFLICTING', 'false', 'true', 'DIRTY'], expected: 'exit:conflicting' },
    { name: '4-required-failed', words: ['OPEN', 'false', 'true', 'MERGEABLE', 'true', 'true', 'BLOCKED'], expected: 'exit:required-failed' },
    { name: '5-in-queue', words: ['OPEN', 'true', 'false', 'MERGEABLE', 'false', 'false', 'BLOCKED'], expected: 'wait:in-queue' },
    { name: '6-checks-running', words: ['OPEN', 'false', 'true', 'MERGEABLE', 'false', 'true', 'BLOCKED'], expected: 'wait:checks-running' },
    { name: '7-not-queued', words: ['OPEN', 'false', 'false', 'MERGEABLE', 'false', 'false', 'CLEAN'], expected: 'exit:not-queued' },
    { name: '8-blocked', words: ['OPEN', 'false', 'true', 'MERGEABLE', 'false', 'false', 'CLEAN'], expected: 'exit:blocked' },
    // Issue の Repro（PR #361）: 必須チェックは通り、queue に入らず、mergeStateStatus が BLOCKED
    { name: 'repro-361-blocked', words: ['OPEN', 'false', 'true', 'MERGEABLE', 'false', 'false', 'BLOCKED'], expected: 'exit:blocked' },
    // 未知の値は列挙に無いので抜ける
    { name: 'unknown-mss', words: ['OPEN', 'false', 'true', 'MERGEABLE', 'false', 'false', 'SOME_FUTURE_VALUE'], expected: 'exit:blocked' },
    { name: 'unknown-mergeable', words: ['OPEN', 'false', 'true', 'SOME_FUTURE_VALUE', 'false', 'false', 'BLOCKED'], expected: 'exit:blocked' },
  ]

  it.for(rows)('$name の語を与えると、$expected を返す', ({ words, expected }) => {
    expect(decide(words)).toBe(expected)
  })

  it('source しても、シェルのオプションを変えない', () => {
    const result = runShell(createHookCase(), `source "${SCRIPT}"; echo "$-"`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).not.toMatch(/[eu]/u)
  })
})

describe('すぐ抜ける状態', () => {
  const rows: { name: string, response: PrResponse, reason: string, code: number, stateLine?: string }[] = [
    {
      name: 'merged',
      response: load('265'),
      reason: 'merged',
      code: 0,
      stateLine: 'MERGED queue=false auto-merge=false mergeable=UNKNOWN mergeStateStatus=UNKNOWN required=passed checks-pending=0',
    },
    {
      name: 'conflicting-with-auto-merge',
      response: variant('262', { auto: true, mergeable: 'CONFLICTING' }),
      reason: 'conflicting',
      code: 1,
      stateLine: 'OPEN queue=false auto-merge=true mergeable=CONFLICTING mergeStateStatus=CLEAN required=passed checks-pending=0',
    },
    {
      name: 'required-checkrun-failed-with-auto-merge',
      response: variant('263', { auto: true }),
      reason: 'required-failed',
      code: 1,
      stateLine: 'OPEN queue=false auto-merge=true mergeable=MERGEABLE mergeStateStatus=BLOCKED required=failed checks-pending=0',
    },
    { name: 'required-statuscontext-failure', response: variant('262', { auto: true, contexts: [contextStatus('ci-result', 'FAILURE')] }), reason: 'required-failed', code: 1 },
    { name: 'required-statuscontext-error', response: variant('262', { auto: true, contexts: [contextStatus('ci-result', 'ERROR')] }), reason: 'required-failed', code: 1 },
    { name: 'no-auto-merge-required-failed', response: load('263'), reason: 'required-failed', code: 1 },
    {
      name: 'left-queue',
      response: load('262'),
      reason: 'not-queued',
      code: 1,
      stateLine: 'OPEN queue=false auto-merge=false mergeable=MERGEABLE mergeStateStatus=CLEAN required=passed checks-pending=0',
    },
    { name: 'closed', response: variant('262', { state: 'CLOSED', mergeable: 'UNKNOWN' }), reason: 'closed', code: 1 },
  ]

  it.for(rows)('$name の応答を受けると、理由 $reason で終了コード $code で抜ける', ({ response, reason, code, stateLine }) => {
    const result = setup().exec([response])
    expect(result.exitCode).toBe(code)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe(`merge-wait: ${reason}`)
    expect(lines.slice(1, 2)).toEqual(stateLine === undefined ? lines.slice(1, 2) : [`state: ${stateLine}`])
    // 3 行目以降は blocked と stalled のときだけ
    expect(lines).toHaveLength(2)
  })
})

describe('待つ状態', () => {
  const rows: { name: string, response: PrResponse }[] = [
    {
      name: 'required-running-and-only-non-required-failed',
      response: variant('262', { auto: true, contexts: [runCheck('tests (x)', 'FAILURE', false), runPending('ci-result'), runCheck('version-plan')] }),
    },
    {
      name: 'non-required-still-running',
      response: variant('262', { auto: true, contexts: [runCheck('ci-result'), runCheck('version-plan'), runPending('tests (slow)', false)] }),
    },
    { name: 'required-queued', response: variant('262', { auto: true, contexts: [runPending('ci-result', true, 'QUEUED'), runCheck('version-plan')] }) },
    { name: 'statuscontext-pending', response: variant('262', { auto: true, contexts: [contextStatus('ci-result', 'PENDING'), runCheck('version-plan')] }) },
    { name: 'ruleset-required-not-yet-reported', response: variant('262', { auto: true, contexts: [runCheck('version-plan')] }) },
    { name: 'in-merge-queue', response: variant('262', { queue: true, auto: false }) },
    { name: 'rollup-null-required-unreported', response: variant('262', { auto: true, noRollup: true }) },
  ]

  it.for(rows)('$name の応答のあと、次の応答まで待ち続ける', ({ response }) => {
    const runner = setup()
    const result = runner.exec([response, MERGED])
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
    expect(countOf(runner.calls(), 'graphql')).toBe(2)
  })
})

describe('予約が残るのに待つものが無い状態', () => {
  const rows: { name: string, response: PrResponse, fragment: string }[] = [
    {
      name: 'required-passed-skipped-neutral-success',
      response: variant('262', {
        auto: true,
        contexts: [runCheck('ci-result', 'SKIPPED'), runCheck('version-plan', 'NEUTRAL'), runCheck('tests (x)', 'SUCCESS', false), contextStatus('legacy', 'SUCCESS', false)],
      }),
      fragment: 'required=passed checks-pending=0',
    },
    { name: 'mergeable-unknown', response: variant('262', { auto: true, mergeable: 'UNKNOWN' }), fragment: 'mergeable=UNKNOWN' },
  ]

  it.for(rows)('$name の応答を受けると、blocked で抜ける', ({ response, fragment }) => {
    const result = setup().exec([response])
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines[1]).toContain(fragment)
  })
})

describe('必須チェックの未報告と ruleset の取得', () => {
  it('報告が 100 件を超えるとき、必須の未報告を数えず blocked で抜ける', () => {
    // 100 件を超えると名前を見切れない
    const response = variant('262', { auto: true, contexts: [runCheck('version-plan')] })
    contextsOf(response).checkRunCount = 101
    const result = setup().exec([response])
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines[1]).toContain('checks-pending=0')
  })

  it('ループが何周しても、rules は開始時に 1 回だけ読む', () => {
    const runner = setup()
    runner.exec([UNREPORTED_RUNNING, UNREPORTED_RUNNING, UNREPORTED_RUNNING, MERGED])
    expect(countOf(runner.calls(), 'rules')).toBe(1)
    expect(countOf(runner.calls(), 'graphql')).toBe(4)
  })

  it('rules が読めなくても、queue の中は待ち、MERGED で抜ける', () => {
    const result = setup().exec([variant('262', { queue: true, auto: false }), MERGED], [], { rules: { __error__: 'gh: Forbidden (HTTP 403)' } })
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
  })

  it('1 回目の取得が失敗したとき、取り直し、必須の ci-result が未報告の間は待つ', () => {
    const runner = setup()
    const unreported = variant('262', { auto: true, contexts: [runCheck('version-plan')] })
    const result = runner.exec([UNREPORTED_RUNNING, unreported, MERGED], [], { rulesFailures: 1 })
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
    expect(countOf(runner.calls(), 'rules')).toBe(2)
    expect(countOf(runner.calls(), 'graphql')).toBe(3)
  })

  it('取得が 3 回失敗したとき、取り直しをやめ、4 回目の応答で blocked になる', () => {
    const runner = setup()
    const result = runner.exec([UNREPORTED_RUNNING, UNREPORTED_RUNNING, UNREPORTED_RUNNING, BLOCKED_BY_RULESET], [], { rulesFailures: 9 })
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines).toContain('rules(main): 取得できない (HTTP 502)')
    expect(countOf(runner.calls(), 'rules')).toBe(3)
  })
})

describe('blocked の出力', () => {
  it('PR #361 の状態のとき、state・rules・code-scanning の alert を出す', () => {
    const result = setup().exec([BLOCKED_BY_RULESET])
    expect(result.exitCode).toBe(1)
    expect(splitLines(result.stdout)).toEqual([
      'merge-wait: blocked',
      'state: OPEN queue=false auto-merge=true mergeable=MERGEABLE mergeStateStatus=BLOCKED required=passed checks-pending=0',
      'rules(main): deletion, non_fast_forward, pull_request, required_status_checks, merge_queue, code_scanning',
      'code-scanning open alerts: #28 #29',
    ])
  })

  it('code_scanning の rule が無いとき、alert を問い合わせない', () => {
    const runner = setup()
    const result = runner.exec([BLOCKED_BY_RULESET], [], { rules: rulesMain().filter(r => r.type !== 'code_scanning') })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain('code-scanning')
    expect(runner.calls()).not.toContain('code-scanning')
  })

  it('開いている alert が無いとき、なし と出す', () => {
    const result = setup().exec([BLOCKED_BY_RULESET], [], { alerts: [] })
    expect(splitLines(result.stdout).at(-1)).toBe('code-scanning open alerts: なし')
  })

  it('mergeStateStatus が未知の値のとき、その値を state に出して blocked で抜ける', () => {
    const result = setup().exec([variant('262', { auto: true, mss: 'SOME_FUTURE_VALUE', contexts: PASSED })])
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines[1]).toContain('mergeStateStatus=SOME_FUTURE_VALUE')
  })

  it('rules の取得が失敗したとき、先頭 2 行は変えず、取得できない旨を 3 行目に出す', () => {
    const result = setup().exec([BLOCKED_BY_RULESET], [], { rules: { __error__: 'gh: Resource not accessible (HTTP 403)' } })
    const lines = splitLines(result.stdout)
    expect(result.exitCode).toBe(1)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines[1]).toMatch(/^state: OPEN /u)
    expect(lines[2]).toBe('rules(main): 取得できない (HTTP 403)')
  })

  it('alert の取得が失敗したとき、HTTP ステータスつきで取得できない旨を出す', () => {
    const result = setup().exec([BLOCKED_BY_RULESET], [], { alerts: { __error__: 'gh: Resource not accessible by personal access token (HTTP 403)' } })
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: blocked')
    expect(lines[2]).toMatch(/^rules\(main\): /u)
    expect(lines[3]).toBe('code-scanning open alerts: 取得できない (HTTP 403)')
  })
})

describe('settle', () => {
  it('settle 中に MERGED を受けるとき、blocked で抜けず merged で抜ける', () => {
    const runner = setup()
    // settle は既定の 120 秒
    const result = runner.exec([BLOCKED_BY_RULESET, MERGED], [], { defaultArguments: ['--interval', '0'] })
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
    expect(countOf(runner.calls(), 'graphql')).toBe(2)
  })

  it('settle 中に queue へ入るとき、not-queued で抜けず待つ', () => {
    const result = setup().exec([load('262'), variant('262', { queue: true, auto: false }), MERGED], [], { defaultArguments: ['--interval', '0'] })
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
  })

  it('settle が 0 秒のとき、blocked を 1 回見たら抜ける', () => {
    const runner = setup()
    const result = runner.exec([BLOCKED_BY_RULESET, BLOCKED_BY_RULESET])
    expect(result.exitCode).toBe(1)
    expect(countOf(runner.calls(), 'graphql')).toBe(1)
  })

  it('blocked が settle の秒数を超えて続くとき、抜ける', () => {
    const runner = setup()
    const result = runner.exec([BLOCKED_BY_RULESET, BLOCKED_BY_RULESET, BLOCKED_BY_RULESET], ['--interval', '1', '--settle-seconds', '1'])
    expect(result.exitCode).toBe(1)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: blocked')
    expect(countOf(runner.calls(), 'graphql')).toBeGreaterThanOrEqual(2)
  })

  it('blocked と not-queued が入れ替わるとき、時計は戻らず、直近の理由で抜ける', () => {
    const runner = setup()
    const left = load('262')
    const result = runner.exec([BLOCKED_BY_RULESET, left, BLOCKED_BY_RULESET, left], ['--interval', '1', '--settle-seconds', '1'])
    expect(result.exitCode).toBe(1)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: not-queued')
    expect(countOf(runner.calls(), 'graphql')).toBe(2)
  })

  it('待つ状態を挟んだとき、settle の時計を戻す', () => {
    const runner = setup()
    const result = runner.exec(
      [BLOCKED_BY_RULESET, UNREPORTED_RUNNING, BLOCKED_BY_RULESET, BLOCKED_BY_RULESET, BLOCKED_BY_RULESET],
      ['--interval', '1', '--settle-seconds', '2'],
    )
    expect(result.exitCode).toBe(1)
    // 時計が戻らなければ 3 回目で抜ける。戻れば 4 回目以降になる（周回が遅い環境では 4 回、通常は 5 回）
    expect([4, 5]).toContain(countOf(runner.calls(), 'graphql'))
  })
})

describe('stalled', () => {
  it('同じ待ち状態が続くとき、stalled で抜ける', () => {
    const runner = setup()
    const running = variant('262', { auto: true, contexts: [runPending('ci-result'), runCheck('version-plan')] })
    const result = runner.exec([running, running, running, MERGED], ['--stall-minutes', '0'])
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: stalled')
    expect(lines[1]).toMatch(/^state: OPEN queue=false auto-merge=true/u)
    expect(lines[1]).toContain('checks-pending=1')
    expect(lines[2]).toMatch(/^rules\(main\): /u)
    expect(countOf(runner.calls(), 'graphql')).toBe(2)
  })

  it('待ち状態が変わり続けるとき、stalled にしない', () => {
    const a = variant('262', { auto: true, contexts: [runPending('ci-result'), runCheck('version-plan')] })
    const b = variant('262', { auto: true, contexts: [runPending('ci-result'), runPending('version-plan')] })
    const result = setup().exec([a, b, a, MERGED], ['--stall-minutes', '0'])
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
  })
})

describe('query-failed', () => {
  const badGateway: ErrorResponse = { __error__: 'gh: Bad Gateway (HTTP 502)' }

  it('gh が 3 回続けて失敗したとき、query-failed で抜ける', () => {
    const runner = setup()
    const result = runner.exec([badGateway, badGateway, badGateway, MERGED])
    expect(result.exitCode).toBe(1)
    const lines = splitLines(result.stdout)
    expect(lines[0]).toBe('merge-wait: query-failed')
    expect(lines[1]).toBe('state: 取得できない')
    expect(result.stdout).toContain('gh: Bad Gateway (HTTP 502)')
    expect(countOf(runner.calls(), 'graphql')).toBe(3)
  })

  it('PR 無しの応答を 3 回続けて受けるとき、query-failed で抜ける', () => {
    const runner = setup()
    const nullPr: PrResponse = { data: { repository: { pullRequest: undefined } } }
    const result = runner.exec([nullPr, nullPr, nullPr, MERGED])
    expect(result.exitCode).toBe(1)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: query-failed')
    expect(result.stdout).toContain('PR not found')
    expect(countOf(runner.calls(), 'graphql')).toBe(3)
  })

  it('失敗が続けてでないとき、数え直して抜けない', () => {
    const result = setup().exec([badGateway, badGateway, variant('262', { queue: true, auto: false }), badGateway, badGateway, MERGED])
    expect(result.exitCode).toBe(0)
    expect(splitLines(result.stdout)[0]).toBe('merge-wait: merged')
  })
})

describe('引数', () => {
  const rows = [
    { name: 'no-target', argv: [] },
    { name: 'bad-target', argv: ['not-a-target'] },
    { name: 'bad-interval', argv: ['--interval', 'x'] },
    { name: 'unknown-option', argv: ['--unknown'] },
  ]

  it.for(rows)('$name の引数を渡すと、usage を stderr に出して終了コード 2 で終わる', ({ argv }) => {
    const result = run(createHookCase(), 'bash', [SCRIPT, ...argv])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('usage:')
  })

  it('スクリプトを確かめるとき、実行権がある', () => {
    expect(isAccessible(constants.X_OK)).toBe(true)
  })
})

function isAccessible(mode: number): boolean {
  try {
    accessSync(SCRIPT, mode)
    return true
  }
  catch {
    return false
  }
}

function step22(): string {
  const text = readFileSync(SKILL, 'utf8')
  return text.slice(text.indexOf('#### 2.2'), text.indexOf('#### 2.3'))
}

describe('SKILL.md', () => {
  const REASONS = ['merged', 'closed', 'conflicting', 'required-failed', 'not-queued', 'blocked', 'stalled', 'query-failed']

  it('2.2 の bash ブロックは、until ループ無しでスクリプトを呼ぶ', () => {
    const block = /```bash\n(.*?)\n```/su.exec(step22())?.[1]
    expect(block).toBe('bash "${CLAUDE_SKILL_DIR}/scripts/merge-wait.sh" <owner>/<repo>/<PR番号>')
    expect(block).not.toContain('until')
    expect(isAccessible(constants.F_OK)).toBe(true)
  })

  it('2.2 の表は、8 つの理由を 1 行ずつ持つ', () => {
    const rows = new Set(Array.from(step22().matchAll(/^\| `([a-z-]+)` \|/gmu), m => m[1]))
    expect(rows).toEqual(new Set(REASONS))
  })
})
