// 器の前提の確認。Node の build は要らない。
// 「シナリオの網羅」は、次の 4 つを確かめる。
//   - シナリオが全件読め、golden の id の集合とシナリオの id の集合が一致する。
//   - 37 サブコマンドの path がすべてシナリオにある。
//   - 各 path に ok と ok 以外があり、全体で auth・4xx・5xx・usage の種類がそろう。
//   - commands.ts の 37 個が src/commands/registry.ts の COMMANDS と一致する。
import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { compareStrings } from './baseline.js'
import { COMMAND_PATHS } from './commands.js'
import { goldenDirectory, kindOf, normalizeDeep, normalizeText, parseScenario, readScenario, scenarioIds } from './scenario.js'

const MINIMAL = `id: issue-read-ok
command: { path: [issue, read], args: [acme/demo/1] }
`

describe('parseScenario', () => {
  it('省いたキーには既定値が入る', () => {
    const scenario = parseScenario('issue-read-ok', MINIMAL)
    expect(scenario.command).toEqual({ path: ['issue', 'read'], args: ['acme/demo/1'] })
    expect(scenario.stdin).toBe('')
    expect(scenario.setup.repo).toEqual({ owner: 'acme', name: 'demo', host: 'ghes.example.com', branch: 'main', commits: [], branches: [], tags: [], worktrees: [], files: {} })
    expect(scenario.setup.cwd).toBe('.')
    expect(scenario.setup.ghToken).toBeUndefined()
    expect(scenario.github).toEqual([])
  })

  it('github の応答は times の既定が 1', () => {
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
  ])('形が崩れていれば落とす: %s', (_label, id, text, message) => {
    expect(() => parseScenario(id, text)).toThrow(message)
  })
})

describe('グローバルオプションだけのシナリオ', () => {
  it('path が空でも読める。id は global-<kind> で始める', () => {
    const scenario = parseScenario('global-ok-version', 'id: global-ok-version\ncommand: { path: [], args: [-v] }\n')
    expect(scenario.command).toEqual({ path: [], args: ['-v'] })
    expect(kindOf(scenario)).toBe('ok')
  })

  it('global で始まらない id は落とす', () => {
    expect(() => parseScenario('version-ok', 'id: version-ok\ncommand: { path: [], args: [-v] }\n')).toThrow('id は')
  })
})

describe('kindOf', () => {
  it('path の次の語を kind にする。path に - を含むコマンドもある', () => {
    expect(kindOf({ id: 'add-to-project-4xx-notfound', command: { path: ['add-to-project'], args: [] } })).toBe('4xx')
    expect(kindOf({ id: 'project-set-repo-ok', command: { path: ['project', 'set-repo'], args: [] } })).toBe('ok')
    expect(kindOf({ id: 'issue-read-bad', command: { path: ['issue', 'read'], args: [] } })).toBeUndefined()
  })
})

describe('正規化', () => {
  const substitutions = [
    { from: '/tmp/pecot-parity-abc', to: '{{TMP}}' },
    { from: 'http://127.0.0.1:4000', to: '{{GITHUB_API}}' },
  ]

  it('一時 root・偽サーバの URL・YYYYMMDD-HHMMSS を固定の文字に置き換える。ISO 日時は置き換えない', () => {
    const text = 'root=/tmp/pecot-parity-abc/x url=http://127.0.0.1:4000/graphql at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name=20260304-050607'
    expect(normalizeText(text, substitutions)).toBe('root={{TMP}}/x url={{GITHUB_API}}/graphql at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name={{TIMESTAMP}}')
  })

  it('オブジェクトのキーと配列の中身にも掛ける', () => {
    expect(normalizeDeep({ '/tmp/pecot-parity-abc/a': ['/tmp/pecot-parity-abc/b', 1, true] }, substitutions)).toEqual({
      '{{TMP}}/a': ['{{TMP}}/b', 1, true],
    })
  })
})

describe('シナリオの網羅', () => {
  const ids = scenarioIds()

  it('シナリオは全件読める', () => {
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(readScenario(id).id).toBe(id)
  })

  it('シナリオと golden が両方向でそろう', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の golden/ を読むだけ
    const goldenIds = readdirSync(goldenDirectory)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .toSorted(compareStrings)
    expect(goldenIds).toEqual(ids)
  })

  it('commands.ts の 37 個が本番の登録（COMMANDS）と一致する', () => {
    const registered = COMMANDS.map(definition => definition.path.join(' '))
    expect(registered.toSorted(compareStrings)).toEqual(COMMAND_PATHS.map(commandPath => commandPath.join(' ')).toSorted(compareStrings))
  })

  it('37 個の path と、シナリオの path の集合が一致する。グローバルオプションだけの path（空）は別に数える', () => {
    const expected = COMMAND_PATHS.map(commandPath => commandPath.join(' ')).toSorted(compareStrings)
    const actual = [...new Set(ids.map(id => readScenario(id).command.path.join(' ')))].filter(key => key !== '').toSorted(compareStrings)
    expect(COMMAND_PATHS).toHaveLength(37)
    expect(actual).toEqual(expected)
  })

  it('グローバルオプションだけのシナリオ（path が空）がある。id は global で始まり、ok と ok 以外がある', () => {
    const kinds = new Set(ids.map(id => readScenario(id)).filter(scenario => scenario.command.path.length === 0).map(scenario => kindOf(scenario)))
    expect(kinds.has('ok')).toBe(true)
    expect(kinds.has('usage')).toBe(true)
    expect(kinds.has('state')).toBe(true)
    expect(kinds.has(undefined)).toBe(false)
  })

  it('各 path に ok と ok 以外が 1 件以上あり、全体で auth・4xx・5xx・usage がそろう', () => {
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
