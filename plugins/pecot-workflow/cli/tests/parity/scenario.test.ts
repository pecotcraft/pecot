// 器の前提の確認。Node の build は要らない。
// 「シナリオの網羅」は、golden とシナリオの id の一致、30 個のツールの網羅、種別のそろい、tools.ts と TOOLS の一致を確かめる。
import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { stepSync } from '../_helpers/step.js'
import { TOOLS } from '../../src/commands/registry.js'
import { compareStrings } from './baseline.js'
import { goldenDirectory, kindOf, normalizeDeep, normalizeText, parseScenario, readScenario, scenarioIds } from './scenario.js'
import { TOOL_NAMES } from './tools.js'

// CLI の使い方の誤りと予行のシナリオを外して、ok か ok 以外の片方だけになったツール
const ONE_SIDED: ReadonlySet<string> = new Set<string>(['session_show'])
// 公式の MCP の読み取りを reads で受けるツール。GitHub を呼ばず、振る舞いは tests/interface が確かめる
const READS_ONLY: ReadonlySet<string> = new Set(['project_check', 'project_activate', 'project_link', 'board_show', 'board_check', 'issue_check', 'issue_dependency_check', 'issue_comment_check', 'session_start', 'session_finish', 'pr_check', 'pr_restack', 'release_check', 'branch_check', 'workflow_install', 'workflow_doctor'])

const MINIMAL = `id: pr-show-ok
tool: pr_show
arguments: { pr_ref: acme/demo#1 }
`

describe('parseScenario', () => {
  it('省略したキーには、既定値が設定される', async () => {
    await explains('シナリオの読み込みのテストです。省略した `setup` などのキーに、既定のリポジトリ設定や既定のディレクトリといった既定値が設定されることを確認します。')
    const scenario = stepSync('キーを省略したシナリオを読み込む', () => parseScenario('pr-show-ok', MINIMAL))
    stepSync('既定値を比べる', () => {
      expect(scenario.tool).toBe('pr_show')
      expect(scenario.arguments).toEqual({ pr_ref: 'acme/demo#1' })
      expect(scenario.setup.repo).toEqual({ owner: 'acme', name: 'demo', host: 'ghes.example.com', branch: 'main', commits: [], branches: [], tags: [], worktrees: [], files: {} })
      expect(scenario.setup.cwd).toBe('.')
      expect(scenario.setup.ghToken).toBeUndefined()
    })
  })

  it('arguments を省略すると、空のオブジェクトになる', async () => {
    await explains('シナリオの `arguments` の読み込みのテストです。`arguments` を省略したシナリオが、空のオブジェクトを渡すシナリオとして読み込まれることを確認します。')
    const scenario = stepSync('arguments を省略したシナリオを読み込む', () => parseScenario('pr-show-usage', 'id: pr-show-usage\ntool: pr_show\n'))
    stepSync('arguments を比べる', () => {
      expect(scenario.arguments).toEqual({})
    })
  })

  it.each([
    ['id がファイル名と違う', 'pr-show-ok', MINIMAL.replace('pr-show-ok', 'pr-show-usage'), 'id がファイル名と違います'],
    ['id がツール名と kind の形でない', 'pr-show', MINIMAL.replace('pr-show-ok', 'pr-show'), 'id は'],
    ['未知の kind', 'pr-show-bad', MINIMAL.replace('pr-show-ok', 'pr-show-bad'), 'id は'],
    ['id が別のツールの名前で始まる', 'pr-read-ok', MINIMAL.replace('pr-show-ok', 'pr-read-ok'), 'id は'],
    ['tool が無い', 'pr-show-ok', 'id: pr-show-ok\n', 'tool が必要です'],
    ['未知のトップのキー', 'pr-show-ok', `${MINIMAL}extra: 1\n`, 'ルート に未知のキー'],
    ['CLI の形の command', 'pr-show-ok', `${MINIMAL}command: { path: [pr, show] }\n`, 'ルート に未知のキー'],
    ['GitHub の応答の github', 'pr-show-ok', `${MINIMAL}github: []\n`, 'ルート に未知のキー'],
    ['files の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    files: { a: 1 }\n`, 'setup.repo.files.a'],
    ['branches に文字列', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    branches: [release]\n`, 'name と commits を持つオブジェクト'],
    ['worktrees の name が wt で始まらない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: sub }]\n`, 'wt で始めて'],
    ['worktrees の files の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  repo:\n    worktrees: [{ name: wt1, files: { a: 1 } }]\n`, 'setup.repo.worktrees[].files.a'],
    ['env の値が文字列でない', 'pr-show-ok', `${MINIMAL}setup:\n  env: { A: 1 }\n`, 'setup.env.A'],
  ])('形式に誤りがあると、例外が発生する: %s', async (_label, id, text, message) => {
    await explains(`シナリオの形式の検証のテストです。\`id\` の不一致や未知のキー、値の型の誤りなど、形式に誤りがある入力を読み込むと、\`${message}\` を含む例外が発生することを確認します。`)
    stepSync('誤りのある入力を読み込むと例外が発生することを確かめる', () => {
      expect(() => parseScenario(id, text)).toThrow(message)
    })
  })
})

describe('kindOf', () => {
  it('id のツール名の次の語を kind として返し、該当する語が存在しない場合は undefined を返す', async () => {
    await explains('シナリオの種別を求める `kindOf` のテストです。`project-get-state-x` では `state`、`project-link-ok` では `ok`、判定できない `pr-show-bad` では `undefined` を返すことを確認します。')
    const kinds = stepSync('3 つのシナリオの種別を求める', () => [
      kindOf({ id: 'project-get-state-x', tool: 'project_get' }),
      kindOf({ id: 'project-link-ok', tool: 'project_link' }),
      kindOf({ id: 'pr-show-bad', tool: 'pr_show' }),
    ])
    stepSync('種別を比べる', () => {
      expect(kinds).toEqual(['state', 'ok', undefined])
    })
  })
})

describe('正規化', () => {
  const substitutions = [
    { from: '/tmp/pecot-parity-abc', to: '{{TMP}}' },
    { from: '/opt/pecot-plugin', to: '{{PLUGIN_ROOT}}' },
  ]

  it('一時ディレクトリ・プラグインのパス・YYYYMMDD-HHMMSS の日時を固定の文字列に置換し、ISO 形式の日時は置換しない', async () => {
    await explains('出力の正規化のテストです。一時ディレクトリとプラグインのパス、`YYYYMMDD-HHMMSS` 形式の日時が `{{TMP}}` などの固定の文字列に置換され、ISO 形式の日時は変更されないことを確認します。')
    const text = 'root=/tmp/pecot-parity-abc/x plugin=/opt/pecot-plugin/cli at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name=20260304-050607'
    const normalized = stepSync('テキストを正規化する', () => normalizeText(text, substitutions))
    stepSync('正規化したテキストを比べる', () => {
      expect(normalized).toBe('root={{TMP}}/x plugin={{PLUGIN_ROOT}}/cli at 2026-03-04T05:06:07Z and 2026-03-04T05:06:07.123+09:00 name={{TIMESTAMP}}')
    })
  })

  it('オブジェクトのキーと配列の要素にも、同じ置換を適用する', async () => {
    await explains('出力の正規化を、入れ子の値に適用するテストです。オブジェクトのキーと配列の要素の文字列にも、パスの置換が適用されることを確認します。')
    const normalized = stepSync('入れ子の値を正規化する', () => normalizeDeep({ '/tmp/pecot-parity-abc/a': ['/tmp/pecot-parity-abc/b', 1, true] }, substitutions))
    stepSync('正規化した値を比べる', () => {
      expect(normalized).toEqual({
        '{{TMP}}/a': ['{{TMP}}/b', 1, true],
      })
    })
  })
})

describe('シナリオの網羅', () => {
  const ids = scenarioIds()

  it('シナリオを全件読み込める', async () => {
    await explains('シナリオの読み込みのテストです。シナリオが 1 件以上存在し、すべての `id` が読み込んだ内容の `id` と一致することを確認します。')
    const loaded = stepSync('シナリオを全件読み込む', () => ids.map(id => readScenario(id).id))
    stepSync('id を比べる', () => {
      expect(ids.length).toBeGreaterThan(0)
      expect(loaded).toEqual(ids)
    })
  })

  it('シナリオの id と golden の id の一覧が一致する', async () => {
    await explains('シナリオと期待出力（golden）の対応のテストです。golden ディレクトリの JSON のファイル名から求めた id の一覧が、シナリオの id の一覧と一致することを確認します。')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の golden/ を読むだけ
    const goldenIds = stepSync('golden の id を集める', () => readdirSync(goldenDirectory)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .toSorted(compareStrings))
    stepSync('id の一覧を比べる', () => {
      expect(goldenIds).toEqual(ids)
    })
  })

  it('tools.ts の 9 個のツールの名前が、本番の登録（TOOLS）から reads を受けるツールを除いた名前と同じ順で一致する', async () => {
    await explains('シナリオ用のツール一覧（`tools.ts`）のテストです。一覧の名前が、本番のツール登録（`TOOLS`）から公式の MCP の読み取りを `reads` で受けるツールを除いた名前と、過不足なく同じ順で一致することを確認します。')
    const registered = stepSync('本番の登録から、reads を受けるツールを除く', () => ({
      writing: TOOLS.map(definition => definition.name).filter(name => !READS_ONLY.has(name)),
      reading: TOOLS.filter(definition => READS_ONLY.has(definition.name)),
    }))
    stepSync('ツールの名前を比べる', () => {
      expect(TOOL_NAMES).toHaveLength(9)
      expect(registered.writing).toEqual(TOOL_NAMES)
      expect(registered.reading).toHaveLength(READS_ONLY.size)
    })
  })

  it('シナリオが使うツールの集合が、9 個のツールの名前と一致する', async () => {
    await explains('シナリオの網羅のテストです。シナリオの `tool` の集合が、9 個のツールの名前と過不足なく一致することを確認します。')
    const actual = stepSync('シナリオが使うツールを集める', () => [...new Set(ids.map(id => readScenario(id).tool))].toSorted(compareStrings))
    stepSync('ツールの集合を比べる', () => {
      expect(actual).toEqual(TOOL_NAMES.toSorted(compareStrings))
    })
  })

  it('片方だけの一覧のツールを除き、各ツールに ok と ok 以外のシナリオがあり、全体で state・usage の種別が含まれる', async () => {
    await explains('ツールごとのシナリオの種別のテストです。片方だけの一覧（`ONE_SIDED`）のツールを除いて ok と ok 以外のシナリオが存在し、全体で `state`・`usage` の種別が含まれることを確認します。')
    const kinds = stepSync('ツールごとの種別を集める', () => {
      const collected = new Map<string, Set<string>>()
      for (const id of ids) {
        const scenario = readScenario(id)
        collected.set(scenario.tool, (collected.get(scenario.tool) ?? new Set()).add(kindOf(scenario) ?? ''))
      }
      return collected
    })
    stepSync('種別のそろいを確かめる', () => {
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
      for (const kind of ['state', 'usage']) expect(all.has(kind)).toBe(true)
    })
  })
})
