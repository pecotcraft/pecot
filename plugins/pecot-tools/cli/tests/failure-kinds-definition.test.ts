// 定義書の exit_status[].kind を、実装が返しうる名前と比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { ALLOWLIST, FAILURE_KINDS, type FailureKind } from '../src/domain/allowlist.js'
import { explains } from '../tests/_helpers/explains.js'

const AUTHORED_PATH = path.resolve(import.meta.dirname, '../../interface/authored.yaml')
const ExitStatusSchema = z.object({ kind: z.string() })
const EntrySchema = z.object({ exit_status: z.array(ExitStatusSchema) })
const AuthoredSchema = z.object({ entries: z.record(z.string(), EntrySchema) })

const authored = AuthoredSchema.parse(parseYaml(readFileSync(AUTHORED_PATH, 'utf8')))
const entries = new Map(Object.entries(authored.entries))
function kindsOf(id: string): readonly string[] {
  const entry = entries.get(id)
  return entry === undefined ? [] : entry.exit_status.map(status => status.kind)
}
function idOf(toolName: string): string {
  const name = toolName.toUpperCase()
  return `PT-${name.replaceAll('_', '-')}`
}
const sorted = (kinds: readonly string[]): readonly string[] => kinds.toSorted((a, b) => a.localeCompare(b))

// classifyFailure は、どの awscli 呼び出しの stderr にも同じ表を使う。
const AWSCLI_KINDS: readonly FailureKind[] = [
  'invalid-input',
  'awscli-missing',
  'auth-missing',
  'auth-expired',
  'permission-denied',
  'resource-not-found',
  'timeout',
  'other',
]
// 実行前の拒否（reject）で not-allowed を返すのは、Athena の start-query-execution だけ。
const NOT_ALLOWED_TOOLS = new Set(['aws_athena_start_query_execution'])

describe('定義書の exit_status と実装', () => {
  it('定義書の exit_status の kind を集めた集合が、実装の FAILURE_KINDS と一致する', async () => {
    await explains('定義書（`interface/authored.yaml`）の `exit_status` に書いた失敗の種類と、実装が返す種類を比較するテストです。すべての項目の `exit_status` の `kind` を重複なく集めた一覧が、`FAILURE_KINDS` と一致することを確認します。')
    const defined = Object.keys(authored.entries).flatMap(id => kindsOf(id))

    expect(sorted([...new Set(defined)])).toEqual(sorted(FAILURE_KINDS))
  })

  it.each(ALLOWLIST.map(entry => entry.toolName))('ツール %s の exit_status は、awscli の実行の失敗で返しうる種類と一致する', async (toolName) => {
    await explains('定義書（`interface/authored.yaml`）の `exit_status` に書いた失敗の種類と、実装が返す種類を比較するテストです。許可リストの各ツールで、共通の種類と一致し、Athena の `start-query-execution` だけに `not-allowed` が加わることを確認します。')
    const expected = NOT_ALLOWED_TOOLS.has(toolName) ? [...AWSCLI_KINDS, 'not-allowed'] : AWSCLI_KINDS

    const actual = sorted(kindsOf(idOf(toolName)))

    expect(actual).toEqual(sorted(expected))
  })

  // SSO の 2 件は awscli を許可リスト経由で呼ばない。失敗の名前は login-registry が classifyFailure で決める。
  it('aws_sso_login の exit_status は、返しうる種類と一致する', async () => {
    await explains('定義書（`interface/authored.yaml`）の `exit_status` に書いた失敗の種類と、実装が返す種類を比較するテストです。`aws_sso_login` の `exit_status` の種類が、awscli の実行で共通の種類と一致することを確認します。')
    expect(sorted(kindsOf('PT-AWS-SSO-LOGIN'))).toEqual(sorted(AWSCLI_KINDS))
  })

  it('aws_sso_login_status の exit_status は、awscli-missing を除いた種類と一致する', async () => {
    await explains('定義書（`interface/authored.yaml`）の `exit_status` に書いた失敗の種類と、実装が返す種類を比較するテストです。`aws_sso_login_status` の `exit_status` の種類が、`awscli-missing` を除いた共通の種類と一致することを確認します。')
    const expected = AWSCLI_KINDS.filter(kind => kind !== 'awscli-missing')

    expect(sorted(kindsOf('PT-AWS-SSO-LOGIN-STATUS'))).toEqual(sorted(expected))
  })
})
