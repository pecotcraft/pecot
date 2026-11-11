// mcp/tools/evidence.ts の unit test。
//
// ハンドラを直接呼び、既定 deps (実 fs) で動く成功ルートとエラー分岐を pin する。
// tools/list に載る形は、src/mcp/tests/contract.test.ts が 10 ツールまとめて見る。
// 対象は inputSchema / outputSchema / annotations。
// そのため、ここでは扱わない。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリ配下のテスト生成物のみを触る */
import { existsSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { buildPng } from '../../../../tests/_helpers/image-fixture.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import type { ToolCallContext } from '../../server.js'
import { evidenceCreateTool } from '../evidence.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'

/**
ハンドラ直接呼び出し用の呼び出し文脈。
本ツールは progress 通知とキャンセルを使わないため、最小限の実装で足りる。
*/
function toolCall(): ToolCallContext {
  return { signal: new AbortController().signal }
}

function callEvidenceCreate(arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  return evidenceCreateTool.handler(arguments_, toolCall())
}

// 引数を Record で受けるのは、CallToolResult が持つ配列メンバのせいで Readonly<CallToolResult> に narrowing できないため。
// errors.test.ts と同じ扱い。
function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
}

const workDirectory = useTemporaryDirectory('pecotv-test-evidence-')

afterEach(() => {
  rmSync(workDirectory(), { recursive: true, force: true })
})

/**
spec JSON と、そこから参照する PNG を実ファイルとして置く。
*/
function placeSpec(spec: Readonly<Record<string, unknown>>): string {
  const specPath = workDirectory('spec.json')
  writeFileSync(specPath, JSON.stringify(spec), 'utf8')
  return specPath
}

function placePng(name: string): string {
  const imagePath = workDirectory(name)
  writeFileSync(imagePath, buildPng(40, 30))
  return imagePath
}

function validSpec(): Record<string, unknown> {
  return {
    title: 'ログイン機能 動作確認エビデンス',
    createdDate: '2026-08-26',
    items: [{ imagePath: placePng('01-login.png'), caption: 'ログイン画面' }],
  }
}

describe('evidence_create ツール', () => {
  it('spec から xlsx を生成し、CLI の --json と同形の data を返す', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-01')
    const specPath = placeSpec(validSpec())
    const outPath = workDirectory('login-evidence.xlsx')

    const result = await callEvidenceCreate({ input_path: specPath, out_path: outPath })
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([outPath])
    expect(dataOf(result)).toEqual({
      event: 'result',
      outPath,
      items: 1,
      annotations: 0,
      skipped: [],
    })
    expect(existsSync(outPath)).toBe(true)
  })

  it('out_path 省略時は input_path と同じディレクトリの evidence.xlsx に書く', async () => {
    // CLI の既定 `./evidence.xlsx` は cwd 依存で MCP からは使えないため、input 基準に導出する。
    const specPath = placeSpec(validSpec())
    const expectedOut = workDirectory('evidence.xlsx')

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(structuredOf(result)['artifacts']).toEqual([expectedOut])
    expect(existsSync(expectedOut)).toBe(true)
  })

  it('除外された画像は skipped に載せたうえで成功扱いにする', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-02')
    const missing = workDirectory('missing.png')
    const specPath = placeSpec({
      title: '一部欠落',
      createdDate: '2026-08-26',
      items: [{ imagePath: placePng('01.png') }, { imagePath: missing }],
    })

    const result = await callEvidenceCreate({
      input_path: specPath,
      out_path: workDirectory('evidence.xlsx'),
    })
    const data = dataOf(result)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(data['items']).toBe(1)
    expect(data['skipped']).toStrictEqual([{ path: missing, reason: 'not-found' }])
  })

  it('相対の input_path は実処理を呼ばず exitCode 2 で返す', async () => {
    const result = await callEvidenceCreate({ input_path: 'spec.json' })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(structured['artifacts']).toEqual([])
    expect(structured['message']).toContain('must be an absolute path')
    expect(dataOf(result)['invalidPaths']).toEqual(['input_path=spec.json'])
  })

  it('相対の out_path も同じく exitCode 2 で弾く', async () => {
    const specPath = placeSpec(validSpec())

    const result = await callEvidenceCreate({ input_path: specPath, out_path: 'out/evidence.xlsx' })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths']).toEqual(['out_path=out/evidence.xlsx'])
  })

  it('spec が存在しないときは input-not-found で exitCode 1', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-05')
    const result = await callEvidenceCreate({ input_path: workDirectory('no-such.json') })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)).toMatchObject({
      event: 'evidence.create.error',
      reason: 'input-not-found',
    })
    expect(structured['message']).not.toBe('')
  })

  it('spec が JSON として破損しているときは invalid-json', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-04')
    const specPath = workDirectory('broken.json')
    writeFileSync(specPath, '{ "title": ', 'utf8')

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('invalid-json')
  })

  it('spec の検証で失敗するときは invalid-spec', async () => {
    const specPath = placeSpec({ title: '', items: [] })

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('invalid-spec')
  })

  it('有効な画像が 1 件も無いときは no-valid-images', async () => {
    const specPath = placeSpec({
      title: '画像なし',
      createdDate: '2026-08-26',
      items: [{ imagePath: workDirectory('missing.png') }],
    })

    const result = await callEvidenceCreate({
      input_path: specPath,
      out_path: workDirectory('evidence.xlsx'),
    })

    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('no-valid-images')
  })

  it('プロセスの stdout / stderr ではなく捕捉した出力を返す', async () => {
    // MCP サーバの process.stdout は JSON-RPC 専有のため、既存コマンドの出力先は
    // 必ず createOutputCapture 側へ差し替わっている必要がある。
    const specPath = placeSpec(validSpec())

    const structured = structuredOf(await callEvidenceCreate({ input_path: specPath }))

    expect(structured['stdout']).toBe('')
    expect(structured['stderr']).toBe('')
  })
})
