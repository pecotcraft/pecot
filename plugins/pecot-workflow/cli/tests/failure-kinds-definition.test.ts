// 定義書の exit_status[].kind を、MCP の結果の kind に入る FAILURE_KINDS と、ツールごとの実装と比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { KIND_BY_CLASS } from '@pecot/workflow-core/commands-shared/failure.js'
import { FAILURE_KINDS } from '@pecot/workflow-core/commands-shared/failure-kind.js'
import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'
import { TOOLS } from '../src/commands/registry.js'
import { interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { compareStrings } from '@pecot/workflow-core/domain/python-format.js'
import { collectReturnedKinds, type ReturnedKind } from './_helpers/returned-kinds.js'

const AUTHORED = path.resolve(import.meta.dirname, '../../interface/authored.yaml')
// FAILURE_KINDS を共有する actions の定義書
const ACTIONS_AUTHORED = path.resolve(import.meta.dirname, '../../../../actions/interface/authored.yaml')
const ExitSchema = z.object({ kind: z.string() })
const EntrySchema = z.object({ exit_status: z.array(ExitSchema) })
const AuthoredSchema = z.object({ entries: z.record(z.string(), EntrySchema) })

const authored = AuthoredSchema.parse(parseYaml(readFileSync(AUTHORED, 'utf8')))
const entries = Object.entries(authored.entries)
const actionsAuthored = AuthoredSchema.parse(parseYaml(readFileSync(ACTIONS_AUTHORED, 'utf8')))
const allEntries = [...Object.values(authored.entries), ...Object.values(actionsAuthored.entries)]
const definedKinds = new Set(allEntries.flatMap(entry => entry.exit_status.map(element => element.kind)))

// MCP のサーバがどのツールでも返す名前。想定外の例外・入力の検証の誤り・セッションのディレクトリの未決定
const UNIVERSAL: readonly string[] = [
  'other',
  'invalid-input',
  'session-directory-unresolved',
]

// 型からは返りうるが、引数の値や呼ぶ順で実際には返らない所（ファイル・名前・項目）
const UNREACHABLE: readonly { readonly file: string, readonly kinds: readonly string[], readonly ids: readonly string[] }[] = [
  // repo の形は、MCP のサーバの prepare が先に確かめる
  { file: 'repository-match.ts', kinds: ['invalid-input'], ids: ['PW-WORKTREE-ADD', 'PW-WORKTREE-INIT', 'PW-WORKTREE-REMOVE'] },
  // release check は、食い違いを warn で流す
  { file: 'repository-match.ts', kinds: ['repo-mismatch'], ids: ['PW-RELEASE-CHECK'] },
  // キーごとの操作の表のうち、値を確かめるのは set だけ
  { file: 'project.ts', kinds: ['invalid-input'], ids: ['PW-PROJECT-GET', 'PW-PROJECT-UNSET'] },
  // WorktreeRuntimeError の個別の名前は、worktree add の作成だけが付ける
  { file: 'worktree.ts', kinds: ['config-invalid', 'no-active-project', 'not-initialized', 'project-not-found', 'repo-not-in-project', 'repo-setting-missing'], ids: ['PW-WORKTREE-INIT', 'PW-WORKTREE-LINK', 'PW-WORKTREE-REMOVE'] },
]

function isUnreachable(id: string, { kind, at }: ReturnedKind): boolean {
  return UNREACHABLE.some(row => at.startsWith(`${row.file}:`) && row.kinds.includes(kind) && row.ids.includes(id))
}

// 例外のクラスから決まる名前。どのツールが投げうるかは、ソースからたどれない
const KINDS_FROM_EXCEPTIONS: ReadonlySet<string> = new Set([...KIND_BY_CLASS.map(([, kind]) => kind), 'other'])

const returned = collectReturnedKinds()

const kindsById: ReadonlyMap<string, ReadonlySet<string>> = new Map(entries.map(([id, entry]) => [id, new Set(entry.exit_status.map(row => row.kind))]))

function kindsOf(id: string): ReadonlySet<string> {
  return kindsById.get(id) ?? new Set()
}

describe('FAILURE_KINDS', () => {
  it('pecot-workflow と actions の定義書の exit_status に出る kind の集合と一致する', async () => {
    await explains('失敗の種別 `FAILURE_KINDS` のテストです。pecot-workflow と actions の定義書の `exit_status` に出てくる `kind` の集合が、両者の共有する `FAILURE_KINDS` と一致することを確認します。')
    stepSync('kind の集合を比べる', () => {
      expect(definedKinds).toEqual(new Set(FAILURE_KINDS))
    })
  })

  it('名前に重複が存在しない', async () => {
    await explains('失敗の種別 `FAILURE_KINDS` のテストです。`FAILURE_KINDS` の名前に重複がなく、すべて異なる名前であることを確認します。')
    const unique = stepSync('重複を除いた名前を集める', () => new Set(FAILURE_KINDS))
    stepSync('名前の数を比べる', () => {
      expect(unique.size).toBe(FAILURE_KINDS.length)
    })
  })
})

describe('項目ごとの exit_status', () => {
  it('どのツールでも返りうる名前を、すべての項目が持つ', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。`other`・`invalid-input`・`session-directory-unresolved` の 3 つの名前を、すべての項目が持つことを確認します。')
    const missing = stepSync('項目が持たない共通の名前を集める', () => entries.flatMap(([id]) => UNIVERSAL.filter(kind => !kindsOf(id).has(kind)).map(kind => `${id} ${kind}`)))
    stepSync('持たない名前が無いことを比べる', () => {
      expect(missing).toEqual([])
    })
  })

  it('ソースから、全ツールの run を見つける', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。ソースから集めた `run` の項目が、登録済みのツールの項目と一致することを確認します。')
    const { found, registered } = stepSync('ソースの項目と登録済みのツールの項目を並べる', () => ({
      found: [...returned].map(([id]) => id).toSorted(compareStrings),
      registered: TOOLS.map(tool => interfaceIdOf(tool.name)).toSorted(compareStrings),
    }))
    stepSync('項目を比べる', () => {
      expect(found).toEqual(registered)
    })
  })

  it('ツールが stopWith・CommandExit に渡す名前を、その項目が持つ', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。ツールが `stopWith` や `CommandExit` に渡す失敗の名前が、対応する項目の `exit_status` に含まれることを確認します。')
    const missing = stepSync('項目が持たない失敗の名前を集める', () => [...returned].flatMap(([id, kinds]) => [...new Set(kinds.filter(returnedKind => !isUnreachable(id, returnedKind)).map(({ kind }) => kind))]
      .filter(kind => !kindsOf(id).has(kind))
      .map(kind => `${id} ${kind}`)))
    stepSync('持たない名前が無いことを比べる', () => {
      expect(missing.toSorted(compareStrings)).toEqual([])
    })
  })

  it('返らないとみなす箇所は、どれもソースに残っている', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。実際には返らないものとして除外している箇所が、いずれもソースに実在し、古くなっていないことを確認します。')
    const stale = stepSync('ソースに残っていない除外の箇所を集める', () => UNREACHABLE.flatMap(row => row.ids.flatMap(id => row.kinds
      .filter(kind => (returned.get(id) ?? []).every(returnedKind => returnedKind.kind !== kind || !isUnreachable(id, returnedKind)))
      .map(kind => `${row.file} ${id} ${kind}`))))
    stepSync('古い箇所が無いことを比べる', () => {
      expect(stale).toEqual([])
    })
  })

  it('例外から決まらない名前は、ツールがどこかで返す', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。例外のクラスから決まらない失敗の名前が、定義書にあるものはすべて、いずれかのツールの実装で返されることを確認します。')
    const unused = stepSync('どのツールも返さない名前を集める', () => entries.flatMap(([id, entry]) => {
      const kinds = new Set((returned.get(id) ?? []).map(({ kind }) => kind))
      return [...new Set(entry.exit_status.map(row => row.kind))]
        .filter(kind => !KINDS_FROM_EXCEPTIONS.has(kind) && kind !== 'session-directory-unresolved' && !kinds.has(kind))
        .map(kind => `${id} ${kind}`)
    }))
    stepSync('返さない名前が無いことを比べる', () => {
      expect(unused.toSorted(compareStrings)).toEqual([])
    })
  })
})
