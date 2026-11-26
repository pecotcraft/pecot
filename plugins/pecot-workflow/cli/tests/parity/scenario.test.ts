// 器の前提の確認。Node の build は要らない。
// 「シナリオの網羅」は、次の 4 つを確かめる。
//   - シナリオが全件読め、golden の id の集合とシナリオの id の集合が一致する。
//   - 39 サブコマンドの path がすべてシナリオにある。
//   - 各 path に ok と ok 以外があり、全体で auth・4xx・5xx・usage の種類がそろう。
//   - commands.ts の 39 個が src/commands/registry.ts の COMMANDS と一致する。
import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { compareStrings } from './baseline.js'
import { COMMAND_PATHS } from './commands.js'
import { goldenDirectory, kindOf, normalizeDeep, normalizeText, parseScenario, readScenario, scenarioIds } from './scenario.js'

const MINIMAL = `id: issue-read-ok
command: { path: [issue, read], args: [acme/demo/1] }
`

describe('parseScenario', () => {
  it('省略したキーには、既定値が設定される', async () => {
    await explains('シナリオの読み込みのテストです。省略した `stdin`・`setup`・`github` などのキーに、空文字や既定のリポジトリ設定といった既定値が設定されることを確認します。')
    const scenario = parseScenario('issue-read-ok', MINIMAL)
    expect(scenario.command).toEqual({ path: ['issue', 'read'], args: ['acme/demo/1'] })
    expect(scenario.stdin).toBe('')
    expect(scenario.setup.repo).toEqual({ owner: 'acme', name: 'demo', host: 'ghes.example.com', branch: 'main', commits: [], branches: [], tags: [], worktrees: [], files: {} })
    expect(scenario.setup.cwd).toBe('.')
    expect(scenario.setup.ghToken).toBeUndefined()
    expect(scenario.github).toEqual([])
  })

  it('github の応答は、times を省略すると 1 になる', async () => {
    await explains('シナリオの `github` の応答の読み込みのテストです。`times` を省略した応答が、`times: 1` として読み込まれることを確認します。')
    const scenario = parseScenario('issue-read-ok', `${MINIMAL}github:
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
    ['id がファイル名と違う', 'issue-read-ok', MINIMAL.replace('issue-read-ok', 'issue-read-usage'), 'id がファイル名と違います'],
    ['id が path と kind の形でない', 'issue-read', MINIMAL.replace('issue-read-ok', 'issue-read'), 'id は'],
    ['未知の kind', 'issue-read-bad', MINIMAL.replace('issue-read-ok', 'issue-read-bad'), 'id は'],
    ['未知のトップのキー', 'issue-read-ok', `${MINIMAL}extra: 1\n`, 'ルート に未知のキー'],
    ['対応表に無い operation', 'issue-read-ok', `${MINIMAL}github:\n  - match: { operation: NoSuch }\n    respond: { status: 200 }\n`, '対応表'],
    ['match が空', 'issue-read-ok', `${MINIMAL}github:\n  - match: {}\n    respond: { status: 200 }\n`, 'method・path・operation'],
    ['status が整数でない', 'issue-read-ok', `${MINIMAL}github:\n  - match: { path: /a }\n    respond: { status: ok }\n`, 'status'],
    ['times が 0', 'issue-read-ok', `${MINIMAL}github:\n  - match: { path: /a }\n    respond: { status: 200 }\n    times: 0\n`, 'times'],
    ['files の値が文字列でない', 'issue-read-ok', `${MINIMAL}setup:\n  repo:\n    files: { a: 1 }\n`, 'setup.repo.files.a'],
    ['branches に文字列', 'issue-read-ok', `${MINIMAL}setup:\n  repo:\n    branches: [release]\n`, 'name と commits を持つオブジェクト'],
    ['worktrees の name が wt で始まらない', 'issue-read-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: sub }]\n`, 'wt で始めて'],
    ['worktrees の files の値が文字列でない', 'issue-read-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: wt1, files: { a: 1 } }]\n`, 'setup.repo.worktrees[].files.a'],
    ['env の値が文字列でない', 'issue-read-ok', `${MINIMAL}setup:\n  env: { A: 1 }\n`, 'setup.env.A'],
  ])('形式に誤りがあると、例外が発生する: %s', async (_label, id, text, message) => {
    await explains(`シナリオの形式の検証のテストです。\`id\` の不一致や未知のキー、値の型の誤りなど、形式に誤りがある入力を読み込むと、\`${message}\` を含む例外が発生することを確認します。`)
    expect(() => parseScenario(id, text)).toThrow(message)
  })
})

describe('グローバルオプションだけのシナリオ', () => {
  it('path が空でも、id が global-<kind> の形なら読み込める', async () => {
    await explains('グローバルオプションだけのシナリオの読み込みのテストです。`path` が空で `id` が `global-ok-version` の場合に、読み込みに成功し、種別が `ok` と判定されることを確認します。')
    const scenario = parseScenario('global-ok-version', 'id: global-ok-version\ncommand: { path: [], args: [-v] }\n')
    expect(scenario.command).toEqual({ path: [], args: ['-v'] })
    expect(kindOf(scenario)).toBe('ok')
  })

  it('path が空で id が global で始まらない場合は、例外が発生する', async () => {
    await explains('グローバルオプションだけのシナリオの `id` の検証のテストです。`path` が空のシナリオの `id` が `global-` で始まらない場合に、例外が発生することを確認します。')
    expect(() => parseScenario('version-ok', 'id: version-ok\ncommand: { path: [], args: [-v] }\n')).toThrow('id は')
  })
})

describe('kindOf', () => {
  it('id の path の次の語を kind として返し、該当する語が存在しない場合は undefined を返す', async () => {
    await explains('シナリオの種別を求める `kindOf` のテストです。`board-add-4xx-notfound` では `4xx`、`project-link-ok` では `ok`、判定できない `issue-show-bad` では `undefined` を返すことを確認します。')
    expect(kindOf({ id: 'board-add-4xx-notfound', command: { path: ['board', 'add'], args: [] } })).toBe('4xx')
    expect(kindOf({ id: 'project-link-ok', command: { path: ['project', 'link'], args: [] } })).toBe('ok')
    expect(kindOf({ id: 'issue-show-bad', command: { path: ['issue', 'show'], args: [] } })).toBeUndefined()
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

  it('commands.ts の 39 個のコマンドの path が、本番の登録（COMMANDS）と一致する', async () => {
    await explains('シナリオ用のコマンド一覧（`commands.ts`）のテストです。一覧の path が、本番のコマンド登録（`COMMANDS`）の path と過不足なく一致することを確認します。')
    const registered = COMMANDS.map(definition => definition.path.join(' '))
    expect(registered.toSorted(compareStrings)).toEqual(COMMAND_PATHS.map(commandPath => commandPath.join(' ')).toSorted(compareStrings))
  })

  it('シナリオが使う path の集合が、39 個のコマンドの path と一致する（path が空のシナリオは除く）', async () => {
    await explains('シナリオの網羅のテストです。シナリオが使う path の集合が、39 個のコマンドの path と一致し、グローバルオプションだけのシナリオ（path が空）は集計から除くことを確認します。')
    const expected = COMMAND_PATHS.map(commandPath => commandPath.join(' ')).toSorted(compareStrings)
    const actual = [...new Set(ids.map(id => readScenario(id).command.path.join(' ')))].filter(key => key !== '').toSorted(compareStrings)
    expect(COMMAND_PATHS).toHaveLength(39)
    expect(actual).toEqual(expected)
  })

  it('path が空のシナリオには ok・usage・state の種別があり、種別を判定できないものは存在しない', async () => {
    await explains('グローバルオプションだけのシナリオ（path が空）の種別のテストです。種別に `ok`・`usage`・`state` が含まれ、種別を判定できないシナリオが存在しないことを確認します。')
    const kinds = new Set(ids.map(id => readScenario(id)).filter(scenario => scenario.command.path.length === 0).map(scenario => kindOf(scenario)))
    expect(kinds.has('ok')).toBe(true)
    expect(kinds.has('usage')).toBe(true)
    expect(kinds.has('state')).toBe(true)
    expect(kinds.has(undefined)).toBe(false)
  })

  it('各 path に ok と ok 以外のシナリオが 1 件以上あり、全体で auth・4xx・5xx・usage の種別が含まれる', async () => {
    await explains('コマンドごとのシナリオの種別のテストです。すべての path に ok と ok 以外のシナリオが存在し、全体で `auth`・`4xx`・`5xx`・`usage` の種別が含まれることを確認します。')
    const kinds = new Map<string, Set<string>>()
    for (const id of ids) {
      const scenario = readScenario(id)
      const key = scenario.command.path.join(' ')
      kinds.set(key, (kinds.get(key) ?? new Set()).add(kindOf(scenario) ?? ''))
    }
    const lacking = COMMAND_PATHS.map(commandPath => commandPath.join(' ')).filter((key) => {
      const found = kinds.get(key) ?? new Set()
      return !found.has('ok') || found.size < 2
    })
    expect(lacking).toEqual([])
    const all = new Set<string>()
    for (const found of kinds.values()) {
      for (const kind of found) all.add(kind)
    }
    for (const kind of ['auth', '4xx', '5xx', 'usage']) expect(all.has(kind)).toBe(true)
  })
})
