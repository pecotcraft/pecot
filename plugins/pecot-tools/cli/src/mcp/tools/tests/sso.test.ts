// SSO ツール層の単体テスト。ハンドラを直接呼び、レジストリ越しの応答の作りを見る。
//
// PATH を stub するため it.concurrent は使わない。ensureAwscli の memo は毎ケース捨てる。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値だけ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の mutable な型を使う */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { useFakeAws } from '../../../../tests/_helpers/fake-aws.js'
import { OUTPUT_LIMIT_BYTES, resetAwscliProbe } from '../../../infra/awscli.js'
import type { ToolCallContext, ToolDefinition } from '../../server.js'
import { TIMEOUT_EXIT_CODE } from '../_shared.js'
import { ssoTools } from '../sso.js'
import { useLoginRegistry } from '../../../../tests/_helpers/login-registry.js'
import { useTemporaryDirectories } from '../../../../tests/_helpers/temporary-directory.js'

/**
キャンセル済みの tools/call を模した呼び出し文脈。

SSO のハンドラは呼び出し文脈を使わない（2 段構成なので abort で子を落とさない）。
それでも SDK は 2 引数で呼ぶため、テストも同じ形で呼んで挙動を固定する。
*/
const ABORTED_CONTEXT: ToolCallContext = { signal: AbortSignal.abort() }

const fakeAws = useFakeAws()
const newRegistry = useLoginRegistry()
const makeFixtureDirectory = useTemporaryDirectories()

beforeEach(() => {
  resetAwscliProbe()
})

function toolOf(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`${name} が組み立てられていない`)
  return found
}

function dataOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error('structuredContent が無い')
  const data = structured['data']
  if (!isRecord(data)) throw new Error('data が無い')
  return data
}

describe('ssoTools', () => {
  it('キャンセル済みの呼び出しでもログインの子プロセスは落とさない', async () => {
    // 開始だけして後で確認するのが 2 段構成の趣旨。abort で子を畳むと、クライアントが
    // 応答を待たずに切った時点で認証フローごと消える。
    fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()
    const tools = ssoTools({ loginRegistry: registry })

    const result = await toolOf(tools, 'aws_sso_login').handler({}, ABORTED_CONTEXT)

    expect(result.structuredContent).toMatchObject({ ok: true, exitCode: 0 })
    expect(dataOf(result)).toMatchObject({
      state: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
    })
    expect(registry.get()?.state).toBe('pending')
  })

  it('status の output は上限で切り詰めて注記を message に残す', async () => {
    const fixtureDirectory = makeFixtureDirectory('pecot-tools-sso-limit-')
    // 上限を確実に超える出力。デバイスフローに入らず exit 0 で終わるので completed になる。
    writeFileSync(
      path.join(fixtureDirectory, 'sso-login.stdout'),
      'x'.repeat(OUTPUT_LIMIT_BYTES + 1024),
    )
    fakeAws.install({ fixtureDir: fixtureDirectory })
    const registry = newRegistry()
    const tools = ssoTools({ loginRegistry: registry })

    await toolOf(tools, 'aws_sso_login').handler({}, ABORTED_CONTEXT)
    const result = await toolOf(tools, 'aws_sso_login_status').handler({}, ABORTED_CONTEXT)

    const output = dataOf(result)['output']
    expect(typeof output).toBe('string')
    expect(Buffer.byteLength(String(output), 'utf8')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
    expect(result.structuredContent).toMatchObject({ ok: true, exitCode: 0 })
    expect(String(isRecord(result.structuredContent) ? result.structuredContent['message'] : ''))
      .toContain('上限')
  })

  it('確定待ちより先にタイムアウトが来ると timed-out を返す', async () => {
    // 既定値（promptTimeoutMs 30 秒 < timeoutMs 10 分）では到達しない分岐。timeoutMs を
    // promptTimeoutMs より短く注入して、loginTimer が先に締め切る形を作る。fixture 名は
    // 存在しないものにして URL / コードが確定しない（= login-registry.test.ts の
    // sso-login.silent と同じ手法）状態を作る。
    fakeAws.install({ fixture: 'sso-login.silent', hang: true })
    const registry = newRegistry({ timeoutMs: 200, promptTimeoutMs: 5000 })
    const tools = ssoTools({ loginRegistry: registry })

    const result = await toolOf(tools, 'aws_sso_login').handler({}, ABORTED_CONTEXT)

    expect(result.structuredContent).toMatchObject({
      ok: false,
      exitCode: TIMEOUT_EXIT_CODE,
      category: 'timeout',
    })
    expect(String(isRecord(result.structuredContent) ? result.structuredContent['message'] : ''))
      .toContain('aws_sso_login を再度呼び出してください')
  })

  it('開始に失敗して出力が上限を超えると注記を message に残す', async () => {
    const fixtureDirectory = makeFixtureDirectory('pecot-tools-sso-fail-limit-')
    writeFileSync(
      path.join(fixtureDirectory, 'sso-login.stderr'),
      'x'.repeat(OUTPUT_LIMIT_BYTES + 1024),
    )
    writeFileSync(path.join(fixtureDirectory, 'sso-login.exit'), '253\n')
    fakeAws.install({ fixtureDir: fixtureDirectory })
    const registry = newRegistry()
    const tools = ssoTools({ loginRegistry: registry })

    const result = await toolOf(tools, 'aws_sso_login').handler({}, ABORTED_CONTEXT)

    expect(result.structuredContent).toMatchObject({ ok: false, exitCode: 253 })
    const stderr = isRecord(result.structuredContent) ? result.structuredContent['stderr'] : undefined
    expect(typeof stderr).toBe('string')
    expect(Buffer.byteLength(String(stderr), 'utf8')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
    expect(String(isRecord(result.structuredContent) ? result.structuredContent['message'] : ''))
      .toContain('上限')
  })
})
