// 定義書の exit_status[].kind を、MCP の結果の kind に入る FAILURE_KINDS と、コマンドごとの実装と比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { KIND_BY_CLASS } from '@pecot/workflow-core/commands-shared/failure.js'
import { FAILURE_KINDS } from '@pecot/workflow-core/commands-shared/failure-kind.js'
import { explains } from './_helpers/explains.js'
import { COMMANDS } from '../src/commands/registry.js'
import { interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { compareStrings } from '@pecot/workflow-core/domain/python-format.js'
import { collectReturnedKinds, type ReturnedKind } from './_helpers/returned-kinds.js'

const AUTHORED = path.resolve(import.meta.dirname, '../../interface/authored.yaml')
const ExitSchema = z.object({ kind: z.string(), code: z.number() })
const EntrySchema = z.object({ exit_status: z.array(ExitSchema) })
const AuthoredSchema = z.object({ entries: z.record(z.string(), EntrySchema) })

const authored = AuthoredSchema.parse(parseYaml(readFileSync(AUTHORED, 'utf8')))
const entries = Object.entries(authored.entries)
const definedKinds = new Set(entries.flatMap(([, entry]) => entry.exit_status.map(element => element.kind)))

// MCP のサーバがどのツールでも返す名前と終了コード。想定外の例外・入力の検証の誤り・セッションのディレクトリの未決定
const UNIVERSAL: readonly { readonly kind: string, readonly code: number }[] = [
  { kind: 'other', code: 1 },
  { kind: 'invalid-input', code: 2 },
  { kind: 'session-directory-unresolved', code: 1 },
]

// 型からは返りうるが、引数の値や呼ぶ順で実際には返らない所（ファイル・名前・項目）
const UNREACHABLE: readonly { readonly file: string, readonly kinds: readonly string[], readonly ids: readonly string[] }[] = [
  // --repo の形は、引数の解析（CLI）と prepare（MCP）が先に確かめる
  { file: 'repository-match.ts', kinds: ['invalid-input'], ids: ['PW-ISSUE-ATTRIBUTES', 'PW-RELEASE-MERGE', 'PW-SESSION-START', 'PW-WORKTREE-ADD', 'PW-WORKTREE-INIT', 'PW-WORKTREE-REMOVE'] },
  { file: 'release.ts', kinds: ['invalid-input'], ids: ['PW-ISSUE-ATTRIBUTES'] },
  // issue attributes・release check・create は、食い違いを warn で流す
  { file: 'repository-match.ts', kinds: ['repo-mismatch'], ids: ['PW-ISSUE-ATTRIBUTES', 'PW-RELEASE-CHECK', 'PW-RELEASE-CREATE'] },
  // キーごとの操作の表のうち、値を確かめるのは set だけ
  { file: 'project.ts', kinds: ['invalid-input'], ids: ['PW-PROJECT-GET', 'PW-PROJECT-UNSET'] },
  // WorktreeRuntimeError の個別の名前は、worktree add の作成だけが付ける
  { file: 'worktree.ts', kinds: ['config-invalid', 'no-active-project', 'not-initialized', 'project-not-found', 'repo-not-in-project', 'repo-setting-missing'], ids: ['PW-WORKTREE-INIT', 'PW-WORKTREE-LINK', 'PW-WORKTREE-REMOVE'] },
]

function isUnreachable(id: string, { kind, at }: ReturnedKind): boolean {
  return UNREACHABLE.some(row => at.startsWith(`${row.file}:`) && row.kinds.includes(kind) && row.ids.includes(id))
}

// 例外のクラスから決まる名前。どのコマンドが投げうるかは、ソースからたどれない
const KINDS_FROM_EXCEPTIONS: ReadonlySet<string> = new Set([...KIND_BY_CLASS.map(([, kind]) => kind), 'other'])

const returned = collectReturnedKinds()

const pairsById: ReadonlyMap<string, ReadonlySet<string>> = new Map(entries.map(([id, entry]) => [id, new Set(entry.exit_status.map(row => `${row.kind}:${String(row.code)}`))]))

function pairsOf(id: string): ReadonlySet<string> {
  return pairsById.get(id) ?? new Set()
}

describe('FAILURE_KINDS', () => {
  it('定義書の exit_status に出る kind の集合と一致する', async () => {
    await explains('失敗の種別 `FAILURE_KINDS` のテストです。定義書の `exit_status` に出てくる `kind` の集合が、`FAILURE_KINDS` と一致することを確認します。')
    expect(definedKinds).toEqual(new Set(FAILURE_KINDS))
  })

  it('名前に重複が存在しない', async () => {
    await explains('失敗の種別 `FAILURE_KINDS` のテストです。`FAILURE_KINDS` の名前に重複がなく、すべて異なる名前であることを確認します。')
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length)
  })
})

describe('項目ごとの exit_status', () => {
  it('どのツールでも返りうる名前を、すべての項目が持つ', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。`other`・`invalid-input`・`session-directory-unresolved` の 3 つの名前と終了コードを、すべての項目が持つことを確認します。')
    const missing = entries.flatMap(([id]) => UNIVERSAL.filter(({ kind, code }) => !pairsOf(id).has(`${kind}:${String(code)}`)).map(({ kind, code }) => `${id} ${kind}:${String(code)}`))
    expect(missing).toEqual([])
  })

  it('ソースから、全コマンドの run を見つける', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。ソースから集めた `run` の項目が、登録済みのコマンドの項目と一致することを確認します。')
    expect([...returned].map(([id]) => id).toSorted(compareStrings)).toEqual(COMMANDS.map(command => interfaceIdOf(command.path)).toSorted(compareStrings))
  })

  it('コマンドが stopWith・CommandExit に渡す名前と終了コードを、その項目が持つ', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。コマンドが `stopWith` や `CommandExit` に渡す失敗の名前と終了コードが、対応する項目の `exit_status` に含まれることを確認します。')
    const missing = [...returned].flatMap(([id, kinds]) => [...new Set(kinds.filter(returnedKind => !isUnreachable(id, returnedKind)).map(({ kind, code }) => `${kind}:${code === undefined ? '?' : String(code)}`))]
      .filter(pair => !pairsOf(id).has(pair))
      .map(pair => `${id} ${pair}`))
    expect(missing.toSorted(compareStrings)).toEqual([])
  })

  it('返らないとみなす箇所は、どれもソースに残っている', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。実際には返らないものとして除外している箇所が、いずれもソースに実在し、古くなっていないことを確認します。')
    const stale = UNREACHABLE.flatMap(row => row.ids.flatMap(id => row.kinds
      .filter(kind => (returned.get(id) ?? []).every(returnedKind => returnedKind.kind !== kind || !isUnreachable(id, returnedKind)))
      .map(kind => `${row.file} ${id} ${kind}`)))
    expect(stale).toEqual([])
  })

  it('例外から決まらない名前は、コマンドがどこかで返す', async () => {
    await explains('定義書の項目ごとの `exit_status` のテストです。例外のクラスから決まらない失敗の名前が、定義書にあるものはすべて、いずれかのコマンドの実装で返されることを確認します。')
    const unused = entries.flatMap(([id, entry]) => {
      const kinds = new Set((returned.get(id) ?? []).map(({ kind }) => kind))
      return [...new Set(entry.exit_status.map(row => row.kind))]
        .filter(kind => !KINDS_FROM_EXCEPTIONS.has(kind) && kind !== 'session-directory-unresolved' && !kinds.has(kind))
        .map(kind => `${id} ${kind}`)
    })
    expect(unused.toSorted(compareStrings)).toEqual([])
  })
})
