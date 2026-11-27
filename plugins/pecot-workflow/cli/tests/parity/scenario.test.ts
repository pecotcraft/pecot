// 器の前提の確認。Node の build は要らない。
// 「シナリオの網羅」は、golden とシナリオの id の一致、30 個のツールの網羅、種別のそろい、tools.ts と TOOLS の一致を確かめる。
import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { TOOLS } from '../../src/commands/registry.js'
import { compareStrings } from './baseline.js'
import { goldenDirectory, kindOf, normalizeDeep, normalizeText, parseScenario, readScenario, scenarioIds } from './scenario.js'
import { TOOL_NAMES } from './tools.js'

// CLI の使い方の誤りと予行のシナリオを外して、ok か ok 以外の片方だけになったツール
const ONE_SIDED: ReadonlySet<string> = new Set<string>()
// GitHub を呼ばないチェックのツール。前後で比べる GitHub への読み書きを持たない
const CHECK_ONLY: ReadonlySet<string> = new Set(['issue_check', 'issue_dependency_check', 'issue_comment_check'])

const MINIMAL = `id: pr-show-ok
tool: pr_show
arguments: { pr_ref: acme/demo#1 }
`

describe('parseScenario', () => {
  it('省略したキーには、既定値が設定される', async () => {
    await explains('シナリオの読み込みのテストです。省略した `setup`・`github` などのキーに、既定のリポジトリ設定や空の配列といった既定値が設定されることを確認します。')
    const scenario = parseScenario('pr-show-ok', MINIMAL)
    expect(scenario.tool).toBe('pr_show')
    expect(scenario.arguments).toEqual({ pr_ref: 'acme/demo#1' })
    expect(scenario.setup.repo).toEqual({ owner: 'acme', name: 'demo', host: 'ghes.example.com', branch: 'main', commits: [], branches: [], tags: [], worktrees: [], files: {} })
    expect(scenario.setup.cwd).toBe('.')
    expect(scenario.setup.ghToken).toBeUndefined()
    expect(scenario.github).toEqual([])
  })

  it('arguments を省略すると、空のオブジェクトになる', async () => {
    await explains('シナリオの `arguments` の読み込みのテストです。`arguments` を省略したシナリオが、空のオブジェクトを渡すシナリオとして読み込まれることを確認します。')
    expect(parseScenario('pr-show-usage', 'id: pr-show-usage\ntool: pr_show\n').arguments).toEqual({})
  })

  it('github の応答は、times を省略すると 1 になる', async () => {
    await explains('シナリオの `github` の応答の読み込みのテストです。`times` を省略した応答が、`times: 1` として読み込まれることを確認します。')
    const scenario = parseScenario('pr-show-ok', `${MINIMAL}github:
  - match: { operation: GetIssueSlim }
    respond: { status: 200, body: { data: {} } }
`)
    expect(scenario.github).toEqual([
      {
        match: { method: undefined, path: undefined, operation: 'GetIssueSlim', query: undefined, variables: undefined, body: undefined },
        respond: { status: 200, body: { data: {} }, text: undefined, headers: undefined },
        times: 1,
      },
    ])
  })

  it.each([
    ['id がファイル名と違う', 'pr-show-ok', MINIMAL.replace('pr-show-ok', 'pr-show-usage'), 'id がファイル名と違います'],
    ['id がツール名と kind の形でない', 'pr-show', MINIMAL.replace('pr-show-ok', 'pr-show'), 'id は'],
    ['未知の kind', 'pr-show-bad', MINIMAL.replace('pr-show-ok', 'pr-show-bad'), 'id は'],
    ['id が別のツールの名前で始まる', 'pr-read-ok', MINIMAL.replace('pr-show-ok', 'pr-read-ok'), 'id は'],
    ['tool が無い', 'pr-show-ok', 'id: pr-show-ok\n', 'tool が必要です'],
    ['未知のトップのキー', 'pr-show-ok', `${MINIMAL}extra: 1\n`, 'ルート に未知のキー'],
    ['CLI の形の command', 'pr-show-ok', `${MINIMAL}command: { path: [pr, show] }\n`, 'ルート に未知のキー'],
    ['対応表に無い operation', 'pr-show-ok', `${MINIMAL}github:\n  - match: { operation: NoSuch }\n    respond: { status: 200 }\n`, '対応表'],
    ['match が空', 'pr-show-ok', `${MINIMAL}github:\n  - match: {}\n    respond: { status: 200 }\n`, 'method・path・operation'],
    ['status が整数でない', 'pr-show-ok', `${MINIMAL}github:\n  - match: { path: /a }\n    respond: { status: ok }\n`, 'status'],
    ['times が 0', 'pr-show-ok', `${MINIMAL}github:\n  - match: { path: /a }\n    respond: { status: 200 }\n    times: 0\n`, 'times'],
    ['files の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    files: { a: 1 }\n`, 'setup.repo.files.a'],
    ['branches に文字列', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    branches: [release]\n`, 'name と commits を持つオブジェクト'],
    ['worktrees の name が wt で始まらない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: sub }]\n`, 'wt で始めて'],
    ['worktrees の files の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: wt1, files: { a: 1 } }]\n`, 'setup.repo.worktrees[].files.a'],
    ['env の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  env: { A: 1 }\n`, 'setup.env.A'],
  ])('形式に誤りがあると、例外が発生する: %s', async (_label, id, text, message) => {
    await explains(`シナリオの形式の検証のテストです。\`id\` の不一致や未知のキー、値の型の誤りなど、形式に誤りがある入力を読み込むと、\`${message}\` を含む例外が発生することを確認します。`)
    expect(() => parseScenario(id, text)).toThrow(message)
  })
})

describe('kindOf', () => {
  it('id のツール名の次の語を kind として返し、該当する語が存在しない場合は undefined を返す', async () => {
    await explains('シナリオの種別を求める `kindOf` のテストです。`board-add-4xx-notfound` では `4xx`、`project-link-ok` では `ok`、判定できない `pr-show-bad` では `undefined` を返すことを確認します。')
    expect(kindOf({ id: 'board-add-4xx-notfound', tool: 'board_add' })).toBe('4xx')
    expect(kindOf({ id: 'project-link-ok', tool: 'project_link' })).toBe('ok')
    expect(kindOf({ id: 'pr-show-bad', tool: 'pr_show' })).toBeUndefined()
  })
})

describe('正規化', () => {
  const substitutions = [
    { from: '/tmp/pecot-parity-abc', to: '{{TMP}}' },
    { from: 'http://127.0.0.1:4000', to: '{{GITHUB_API}}' },
  ]

  it('一時ディレクトリ・偽サーバの URL・YYYYMMDD-HHMMSS の日時を固定の文字列に置換し、ISO 形式の日時は置換しない', async () => {
    await explains('出力の正規化のテストです。一時ディレクトリのパスと偽サーバの URL、`YYYYMMDD-HHMMSS` 形式の日時が `{{TMP}}` などの固定の文字列に置換され、ISO 形式の日時は変更されないことを確認します。')
    const text = 'root=/tmp/pecot-parity-abc/x url=http://127.0.0.1:4000/graphql at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name=20260304-050607'
    expect(normalizeText(text, substitutions)).toBe('root={{TMP}}/x url={{GITHUB_API}}/graphql at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name={{TIMESTAMP}}')
  })

  it('オブジェクトのキーと配列の要素にも、同じ置換を適用する', async () => {
    await explains('出力の正規化を、入れ子の値に適用するテストです。オブジェクトのキーと配列の要素の文字列にも、パスの置換が適用されることを確認します。')
    expect(normalizeDeep({ '/tmp/pecot-parity-abc/a': ['/tmp/pecot-parity-abc/b', 1, true] }, substitutions)).toEqual({
      '{{TMP}}/a': ['{{TMP}}/b', 1, true],
    })
  })
})

describe('シナリオの網羅', () => {
  const ids = scenarioIds()

  it('シナリオを全件読み込める', async () => {
    await explains('シナリオの読み込みのテストです。シナリオが 1 件以上存在し、すべての `id` が読み込んだ内容の `id` と一致することを確認します。')
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(readScenario(id).id).toBe(id)
  })

  it('シナリオの id と golden の id の一覧が一致する', async () => {
    await explains('シナリオと期待出力（golden）の対応のテストです。golden ディレクトリの JSON のファイル名から求めた id の一覧が、シナリオの id の一覧と一致することを確認します。')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の golden/ を読むだけ
    const goldenIds = readdirSync(goldenDirectory)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .toSorted(compareStrings)
    expect(goldenIds).toEqual(ids)
  })

  it('tools.ts の 30 個のツールの名前が、本番の登録（TOOLS）からチェックのツールを除いた名前と同じ順で一致する', async () => {
    await explains('シナリオ用のツール一覧（`tools.ts`）のテストです。一覧の名前が、本番のツール登録（`TOOLS`）から GitHub を呼ばないチェックのツールを除いた名前と、過不足なく同じ順で一致することを確認します。')
    expect(TOOL_NAMES).toHaveLength(30)
    expect(TOOLS.map(definition => definition.name).filter(name => !CHECK_ONLY.has(name))).toEqual(TOOL_NAMES)
    expect(TOOLS.filter(definition => CHECK_ONLY.has(definition.name))).toHaveLength(CHECK_ONLY.size)
  })

  it('シナリオが使うツールの集合が、30 個のツールの名前と一致する', async () => {
    await explains('シナリオの網羅のテストです。シナリオの `tool` の集合が、30 個のツールの名前と過不足なく一致することを確認します。')
    const actual = [...new Set(ids.map(id => readScenario(id).tool))].toSorted(compareStrings)
    expect(actual).toEqual(TOOL_NAMES.toSorted(compareStrings))
  })

  it('片方だけの一覧のツールを除き、各ツールに ok と ok 以外のシナリオがあり、全体で auth・4xx・5xx・usage の種別が含まれる', async () => {
    await explains('ツールごとのシナリオの種別のテストです。片方だけの一覧（`ONE_SIDED`）のツールを除いて ok と ok 以外のシナリオが存在し、全体で `auth`・`4xx`・`5xx`・`usage` の種別が含まれることを確認します。')
    const kinds = new Map<string, Set<string>>()
    for (const id of ids) {
      const scenario = readScenario(id)
      kinds.set(scenario.tool, (kinds.get(scenario.tool) ?? new Set()).add(kindOf(scenario) ?? ''))
    }
    const lacking = TOOL_NAMES.filter(name => !ONE_SIDED.has(name)).filter((name) => {
      const found = kinds.get(name) ?? new Set()
      return !found.has('ok') || found.size < 2
    })
    expect(lacking).toEqual([])
    expect([...ONE_SIDED].filter(name => (kinds.get(name)?.size ?? 0) !== 1)).toEqual([])
    const all = new Set<string>()
    for (const found of kinds.values()) {
      for (const kind of found) all.add(kind)
    }
    for (const kind of ['auth', '4xx', '5xx', 'usage']) expect(all.has(kind)).toBe(true)
  })
})
