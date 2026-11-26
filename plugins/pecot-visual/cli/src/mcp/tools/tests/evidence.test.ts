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
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { buildPng } from '../../../../tests/_helpers/image-fixture.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { explains } from '../../../../tests/_helpers/explains.js'
import type { ToolCallContext } from '../../server.js'
import { evidenceCreateTool as evidenceCreateDefinition } from '../evidence.js'
import { withOutputCheck } from './_output.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'

/**
ハンドラ直接呼び出し用の呼び出し文脈。
本ツールは progress 通知とキャンセルを使わないため、最小限の実装で足りる。
*/
function toolCall(): ToolCallContext {
  return { signal: new AbortController().signal }
}

function callEvidenceCreate(arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
  return withOutputCheck(evidenceCreateDefinition).handler(arguments_, toolCall())
}

// 引数を Record で受けるのは、CallToolResult が持つ配列メンバのせいで Readonly<CallToolResult> に narrowing できないため。
// errors.test.ts と同じ扱い。
function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredOf(result)
}

function sentenceOf(result: Readonly<Record<string, unknown>>): string {
  const content = result['content']
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
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
  it('spec から xlsx を生成し、CLI の --json と同形の項目を返す', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-01')
    await explains('`evidence_create` ツールが、仕様の JSON から xlsx を生成するテストです。有効な仕様と画像を渡した場合に、CLI の `--json` と同じ形の結果を返し、`out_path` に xlsx が書き出されることを確認します。')
    const specPath = placeSpec(validSpec())
    const outPath = workDirectory('login-evidence.xlsx')

    const result = await callEvidenceCreate({ input_path: specPath, out_path: outPath })
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured).toStrictEqual({
      event: 'result',
      outPath,
      items: 1,
      annotations: 0,
      skipped: [],
    })
    expect(existsSync(outPath)).toBe(true)
  })

  it('out_path を省略すると、input_path と同じディレクトリの evidence.xlsx に書き出す', async () => {
    await explains('`evidence_create` ツールの出力先を省略した場合のテストです。`out_path` を省略したときに、`input_path` と同じディレクトリの `evidence.xlsx` へ書き出され、結果の `outPath` にそのパスが入ることを確認します。')
    // CLI の既定 `./evidence.xlsx` は cwd 依存で MCP からは使えないため、input 基準に導出する。
    const specPath = placeSpec(validSpec())
    const expectedOut = workDirectory('evidence.xlsx')

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(structuredOf(result)['outPath']).toBe(expectedOut)
    expect(existsSync(expectedOut)).toBe(true)
  })

  it('除外された画像は skipped に載せたうえで成功扱いにする', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-02')
    await explains('`evidence_create` ツールが、除外した画像を扱うテストです。仕様に存在しない画像のパスが含まれる場合に、エラーにはせず成功のまま、その画像を `skipped` に載せることを確認します。')
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

    expect(result.isError).toBeUndefined()
    expect(data['items']).toBe(1)
    expect(data['skipped']).toStrictEqual([{ path: missing, reason: 'not-found' }])
  })

  it('相対の input_path は実処理を呼ばず invalid-path で返す', async () => {
    await explains('`evidence_create` ツールの入力パスの検証のテストです。`input_path` に相対パスを指定した場合に、実処理に進まず `invalid-path` のエラーと、該当する指定の一覧を返すことを確認します。')
    const result = await callEvidenceCreate({ input_path: 'spec.json' })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('invalid-path')
    expect(structured['detail']).toContain('must be an absolute path')
    expect(dataOf(result)['invalidPaths']).toEqual(['input_path=spec.json'])
  })

  it('相対の out_path も同じく invalid-path で弾く', async () => {
    await explains('`evidence_create` ツールの出力先パスの検証のテストです。`out_path` に相対パスを指定した場合に、`invalid-path` のエラーを返し、`invalidPaths` に `out_path` の指定が入ることを確認します。')
    const specPath = placeSpec(validSpec())

    const result = await callEvidenceCreate({ input_path: specPath, out_path: 'out/evidence.xlsx' })

    expect(structuredOf(result)['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['out_path=out/evidence.xlsx'])
  })

  it('spec が存在しないときは input-not-found で返す', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-05')
    await explains('`evidence_create` ツールの仕様ファイルの検証のテストです。`input_path` で存在しないファイルを指定した場合に、`input-not-found` のエラーを返し、本文が結果の `detail` と一致することを確認します。')
    const result = await callEvidenceCreate({ input_path: workDirectory('no-such.json') })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured).toMatchObject({
      event: 'evidence.create.error',
      kind: 'input-not-found',
    })
    expect(structured).not.toHaveProperty('reason')
    expect(sentenceOf(result)).not.toBe('')
    expect(sentenceOf(result)).toBe(structured['detail'])
  })

  it('spec が JSON として破損しているときは invalid-json', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-04')
    await explains('`evidence_create` ツールの仕様ファイルの検証のテストです。JSON として不正なファイルを指定した場合に、`invalid-json` のエラーを返すことを確認します。')
    const specPath = workDirectory('broken.json')
    writeFileSync(specPath, '{ "title": ', 'utf8')

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('invalid-json')
  })

  it('spec の検証で失敗するときは invalid-spec', async () => {
    await explains('`evidence_create` ツールの仕様の内容の検証のテストです。`title` が空で `items` も空の仕様を渡した場合に、`invalid-spec` のエラーを返すことを確認します。')
    const specPath = placeSpec({ title: '', items: [] })

    const result = await callEvidenceCreate({ input_path: specPath })

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('invalid-spec')
  })

  it('有効な画像が 1 件も無いときは no-valid-images', async () => {
    await explains('`evidence_create` ツールの画像の検証のテストです。仕様に含まれる画像がすべて存在しない場合に、`no-valid-images` のエラーを返すことを確認します。')
    const specPath = placeSpec({
      title: '画像なし',
      createdDate: '2026-08-26',
      items: [{ imagePath: workDirectory('missing.png') }],
    })

    const result = await callEvidenceCreate({
      input_path: specPath,
      out_path: workDirectory('evidence.xlsx'),
    })

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('no-valid-images')
  })

  it('成功の結果に、入れ物の項目と、捕捉した出力の stdout / stderr・log を載せない', async () => {
    await explains('`evidence_create` ツールの成功時の結果の形のテストです。成功した場合に、結果が `annotations`・`event`・`items`・`outPath`・`skipped` の 5 項目だけを持ち、標準出力などの捕捉した出力を含まないことを確認します。')
    const specPath = placeSpec(validSpec())

    const structured = structuredOf(await callEvidenceCreate({ input_path: specPath }))

    expect(Object.keys(structured).toSorted(compareStrings)).toEqual(['annotations', 'event', 'items', 'outPath', 'skipped'])
  })
})
