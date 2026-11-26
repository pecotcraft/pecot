// drawio_create / evidence_create の文面確認の統合テスト。
//
// lintText は実物（辞書同梱）を使う。違反文は literal で持たず、語を分けて組み立てる。
// SC-002 の比較は、同じ文を止める 8 つの場所が同じ 3 規則名を返すことを確かめる。
// 期待値は規則名の literal に固定する。lintText の結果を期待値にすると、辞書の更新で当たらなくなったとき
// 全場所が同じ縮んだ集合のまま通ってしまう。
// 判定器の失敗（text-lint-failed）は実機で再現できない。ここでだけ lintText を reject させて確かめる。
// drawio は png: false として、Chromium の有無の影響を避ける。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリ配下のテスト生成物のみを触る */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { lintText } from '@pecot/text-rules'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'
import { attachOutput } from '../../../tests/_helpers/attach.js'
import { buildPng } from '../../../tests/_helpers/image-fixture.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { redundantExpression } from '../../../tests/_helpers/redundant-expression.js'
import { assertTemplatePluginsBuilt, createTalkDirectory } from '../../../tests/_helpers/talk-directory.js'
import { useTemporaryDirectory } from '../../../tests/_helpers/temporary-directory.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import type { ToolCallContext } from '../server.js'
import { drawioCreateTool } from '../tools/drawio.js'
import { evidenceCreateTool } from '../tools/evidence.js'
import { slideLintTool } from '../tools/slide.js'
import { withOutputCheck } from '../tools/tests/_output.js'
import { explains } from '../../../tests/_helpers/explains.js'

const CALL: ToolCallContext = { signal: new AbortController().signal }

// 違反文を literal で持たない。fixture に完成した違反文を置かないため、語を分けて組み立てる。
const HYPE_ID = 'no-ai-hype-expressions'
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')
const HYPE_2 = ['ゲーム', 'チェンジャー', 'となる仕組みです。'].join('')
const HYPE_3 = ['ゲーム', 'チェンジャー', 'となる設計です。'].join('')
const CLEAN = '処理の流れを説明します。'
const VIOLATION_MESSAGE_1 = '1 text violations; fix the text without loosening the rules, then run again'
const VIOLATION_MESSAGE_3 = '3 text violations; fix the text without loosening the rules, then run again'

const workDirectory = useTemporaryDirectory('pecotv-test-text-violation-')

afterEach(() => {
  vi.doUnmock('@pecot/text-rules')
  vi.resetModules()
  rmSync(workDirectory(), { recursive: true, force: true })
})

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredOf(result)
}

function sentenceOf(result: { readonly content?: unknown }): string {
  const content: unknown = result.content
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
}

function violationsOf(result: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const violations = dataOf(result)['violations']
  if (!Array.isArray(violations)) throw new TypeError('violations が配列ではありません')
  return violations.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error('violations の要素が object ではありません')
    return { ...entry }
  })
}

function diagram(cells: string): string {
  return `<mxfile><diagram id="d" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`
}

function placeDiagram(cells: string): { input: string, out: string } {
  const input = workDirectory('d.drawio')
  writeFileSync(input, diagram(cells), 'utf8')
  return { input, out: workDirectory('d.drawio.html') }
}

function callDrawio(input: string, out: string): Promise<CallToolResult> {
  return withOutputCheck(drawioCreateTool).handler({ input_path: input, out_path: out, png: false }, CALL)
}

function placeEvidence(spec: Readonly<Record<string, unknown>>): { input: string, out: string } {
  const input = workDirectory('spec.json')
  writeFileSync(input, JSON.stringify(spec), 'utf8')
  return { input, out: workDirectory('e.xlsx') }
}

function placePng(): string {
  const imagePath = workDirectory('a.png')
  writeFileSync(imagePath, buildPng(40, 30))
  return imagePath
}

function callEvidence(input: string, out: string): Promise<CallToolResult> {
  return withOutputCheck(evidenceCreateTool).handler({ input_path: input, out_path: out }, CALL)
}

describe('drawio_create の文面確認', () => {
  it('違反のあるラベルが 1 件の場合は、text-violation で失敗し、ファイルを書き出さない', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-05')
    await explains('文章規則に違反するラベルが 1 件ある図を、`drawio_create` で変換する場合のテストです。`text-violation` の失敗になり、違反の項目、規則名、文が返され、出力のファイルが作成されないことを確認します。')
    const { input, out } = placeDiagram(`<mxCell id="n1" value="${HYPE}" vertex="1" parent="1"/>`)

    const result = await callDrawio(input, out)
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('text-violation')
    expect(sentenceOf(result)).toContain(VIOLATION_MESSAGE_1)
    expect(dataOf(result)['event']).toBe('drawio.url.error')
    expect(structuredOf(result)['kind']).toBe('text-violation')
    const [violation, ...rest] = violationsOf(result)
    expect(rest).toStrictEqual([])
    expect(violation).toMatchObject({ item: 'mxCell id="n1"', ruleId: HYPE_ID, text: HYPE })
    expect(typeof violation?.['message']).toBe('string')
    expect(existsSync(out)).toBe(false)
  })

  it('違反のあるラベルが 3 件（value、object の label、html=1 の value）の場合は、すべてを返し、違反のないセルは含めない', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-05')
    await explains('3 種類の書き方で違反のあるラベルと、違反のないラベルを含む図を、`drawio_create` で変換する場合のテストです。違反のある 3 件だけが返され、違反のないセルは含まれず、出力のファイルが作成されないことを確認します。')
    const { input, out } = placeDiagram(
      `<mxCell id="n1" value="${HYPE}" vertex="1" parent="1"/>`
      + `<object id="n2" label="${HYPE_2}"><mxCell vertex="1" parent="1"/></object>`
      + `<mxCell id="n3" value="&lt;b&gt;${HYPE_3}&lt;/b&gt;" style="html=1;" vertex="1" parent="1"/>`
      + `<mxCell id="n4" value="${CLEAN}" vertex="1" parent="1"/>`,
    )

    const result = await callDrawio(input, out)

    expect(sentenceOf(result)).toContain(VIOLATION_MESSAGE_3)
    expect(violationsOf(result).map(v => [v['item'], v['ruleId'], v['text']])).toStrictEqual([
      ['mxCell id="n1"', HYPE_ID, HYPE],
      ['mxCell id="n2"', HYPE_ID, HYPE_2],
      ['mxCell id="n3"', HYPE_ID, HYPE_3],
    ])
    expect(existsSync(out)).toBe(false)
  })

  it('違反がない場合は、これまでどおり表示用の HTML を書き出す', async () => {
    await explains('文章規則に違反するラベルがない図を、`drawio_create` で変換する場合のテストです。失敗の `kind` が含まれず、出力の HTML ファイルが作成されることを確認します。')
    const { input, out } = placeDiagram(`<mxCell id="n1" value="${CLEAN}" vertex="1" parent="1"/>`)

    const result = await callDrawio(input, out)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(existsSync(out)).toBe(true)
  })

  it('文章規則の確認自体が失敗した場合は、text-lint-failed で失敗し、ファイルを書き出さない', async () => {
    await explains('文章規則の確認が失敗する場合の、`drawio_create` のテストです。`text-lint-failed` の失敗になり、`detail` に失敗の原因が含まれ、`violations` を含まず、出力のファイルが作成されないことを確認します。')
    vi.doMock('@pecot/text-rules', () => ({
      lintText: () => Promise.reject(new Error('辞書を読めません')),
    }))
    const { input, out } = placeDiagram(`<mxCell id="n1" value="${CLEAN}" vertex="1" parent="1"/>`)

    const result = await callDrawio(input, out)

    expect(structuredOf(result)['kind']).toBe('text-lint-failed')
    expect(String(dataOf(result)['detail'])).toContain('辞書を読めません')
    expect(dataOf(result)['violations']).toBeUndefined()
    expect(existsSync(out)).toBe(false)
  })
})

describe('evidence_create の文面確認', () => {
  it('title に違反がある場合は、text-violation で失敗し、xlsx を書き出さない', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-03')
    await explains('`title` が文章規則に違反する入力を、`evidence_create` に渡した場合のテストです。`text-violation` の失敗になり、違反の項目として `title` が返され、xlsx が作成されないことを確認します。')
    const { input, out } = placeEvidence({
      title: HYPE,
      createdDate: '2026-10-28',
      items: [{ imagePath: placePng(), caption: CLEAN }],
    })

    const result = await callEvidence(input, out)
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('text-violation')
    expect(sentenceOf(result)).toContain(VIOLATION_MESSAGE_1)
    expect(dataOf(result)['event']).toBe('evidence.create.error')
    expect(structuredOf(result)['kind']).toBe('text-violation')
    expect(violationsOf(result).map(v => [v['item'], v['ruleId'], v['text']])).toStrictEqual([
      ['title', HYPE_ID, HYPE],
    ])
    expect(existsSync(out)).toBe(false)
  })

  it('title、caption、callout の 3 項目の違反を、すべて返す', async (context) => {
    await verifies(context, 'PV-EVIDENCE-CREATE-03')
    await explains('`title`、`caption`、注釈の `callout` のすべてが違反する入力を、`evidence_create` に渡した場合のテストです。3 項目の違反がすべて返され、xlsx が作成されないことを確認します。')
    const { input, out } = placeEvidence({
      title: HYPE,
      createdDate: '2026-10-28',
      items: [{
        imagePath: placePng(),
        caption: HYPE_2,
        annotations: [
          { type: 'highlight', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { type: 'callout', text: HYPE_3, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, anchor: { x: 0.5, y: 0.5 } },
        ],
      }],
    })

    const result = await callEvidence(input, out)

    expect(sentenceOf(result)).toContain(VIOLATION_MESSAGE_3)
    expect(violationsOf(result).map(v => v['item'])).toStrictEqual([
      'title',
      'items[0].caption',
      'items[0].annotations[1].text',
    ])
    expect(existsSync(out)).toBe(false)
  })

  it('入力の spec は書き換えない', async () => {
    await explains('`title` に違反がある入力を、`evidence_create` に渡した場合のテストです。`text-violation` の失敗になり、入力の spec ファイルの内容が変更されないことを確認します。')
    const { input, out } = placeEvidence({
      title: HYPE,
      createdDate: '2026-10-28',
      items: [{ imagePath: placePng() }],
    })
    const before = readFileSync(input, 'utf8')

    const result = await callEvidence(input, out)

    expect(structuredOf(result)['kind']).toBe('text-violation')
    expect(readFileSync(input, 'utf8')).toBe(before)
  })

  it('文章規則の確認自体が失敗した場合は、text-lint-failed で失敗し、xlsx を書き出さない', async () => {
    await explains('文章規則の確認が失敗する場合の、`evidence_create` のテストです。`text-lint-failed` の失敗になり、`detail` に失敗の原因が含まれ、xlsx が作成されないことを確認します。')
    vi.doMock('@pecot/text-rules', () => ({
      lintText: () => Promise.reject(new Error('辞書を読めません')),
    }))
    const { input, out } = placeEvidence({
      title: CLEAN,
      createdDate: '2026-10-28',
      items: [{ imagePath: placePng(), caption: CLEAN }],
    })

    const result = await callEvidence(input, out)

    expect(structuredOf(result)['kind']).toBe('text-lint-failed')
    expect(String(dataOf(result)['detail'])).toContain('辞書を読めません')
    expect(existsSync(out)).toBe(false)
  })
})

// SC-002: 同じ文を止める場所が、同じ規則名の集合を返す。件数・位置は場所ごとに異なるため比べない。
const REDUNDANT = ['設定を変更', await redundantExpression(), '。'].join('')
const PARITY_TEXT = HYPE + REDUNDANT
const PARITY_RULES = new Set(['no-ai-hype-expressions', 'ai-tech-writing-guideline', 'ja-no-redundant-expression'])

// 「…（ruleId）」で終わるメッセージから規則名を取り出す。
function ruleIdOfMessage(message: string): string {
  const matched = /\(([^()]+)\)$/.exec(message)
  if (matched?.[1] === undefined) throw new Error(`末尾に（規則名）がありません: ${message}`)
  return matched[1]
}

function ruleIdsOf(violations: readonly Readonly<Record<string, unknown>>[]): Set<string> {
  return new Set(violations.map(v => String(v['ruleId'])))
}

// talk-dir に section ページを足す。frontmatter の表示項目と本文に同じ文を置く。
async function placeParityTalk(): Promise<string> {
  const talk = await createTalkDirectory(workDirectory(), 'parity', {
    'text-constraints/textlint': 'error',
    'text-constraints/textlint-body': 'error',
  })
  mkdirSync(path.join(talk, 'pages'), { recursive: true })
  writeFileSync(
    path.join(talk, 'pages', 'parity.md'),
    ['---', 'layout: section', 'heading: 基盤', `description: ${PARITY_TEXT}`, '---', '', PARITY_TEXT, ''].join('\n'),
    'utf8',
  )
  writeFileSync(path.join(talk, 'slides.md'), `${readFileSync(path.join(talk, 'slides.md'), 'utf8')}\n---\nsrc: ./pages/parity.md\n---\n`, 'utf8')
  return talk
}

async function slideLintRuleIds(rule: string): Promise<Set<string>> {
  const result = await withOutputCheck(slideLintTool()).handler({ dir: await placeParityTalk() }, CALL)
  const violations = dataOf(result)['violations']
  if (!Array.isArray(violations)) throw new TypeError('violations が配列ではありません')
  return new Set(
    violations
      .filter((entry: unknown) => isRecord(entry) && entry['rule'] === rule)
      .map((entry: unknown) => ruleIdOfMessage(String(isRecord(entry) ? entry['message'] : ''))),
  )
}

describe('SC-002 止める場所ごとの規則名の一致', () => {
  // slide_lint の 2 件だけがテンプレート側 eslint plugin の dist を使う
  beforeAll(assertTemplatePluginsBuilt)

  it('fragment を lintText に渡すと、ほかの止める場所と同じ 3 つの規則名を返す', async () => {
    await explains('文章規則を確認する `lintText` に、禁止された表現を含む文を `fragment` として渡した場合のテストです。ほかの確認の場所と同じ、3 つの規則名の違反が返ることを確認します。')
    const findings = await lintText(PARITY_TEXT, 'fragment')

    expect(new Set(findings.map(finding => finding.ruleId))).toStrictEqual(PARITY_RULES)
  })

  it.each([
    ['pecot-text-lint（bin）の .md', 'parity.md', `${PARITY_TEXT}\n`, []],
    ['pecot-text-lint（bin）の .ts の文字列', 'parity.ts', `export const text = '${PARITY_TEXT}'\n`, []],
    ['pecot-text-lint（bin）の .vue の template', 'parity.vue', `<template>\n  <p>${PARITY_TEXT}</p>\n</template>\n`, []],
    ['pecot-text-lint（bin）の --commit-msg', 'COMMIT_EDITMSG', `fix: ${PARITY_TEXT}\n`, ['--commit-msg']],
  ])('%s のとき、ほかの止める場所と同じ 3 つの規則名を返す', async (_name, name, content, options) => {
    await explains('`pecot-text-lint` に、禁止された表現を含むファイルを渡した場合のテストです。終了コードが 1 になり、出力された違反の規則名が、ほかの確認の場所と同じ 3 つになることを確認します。')
    const entry = fileURLToPath(import.meta.resolve('@pecot/text-rules'))
    const bin = path.join(path.dirname(entry), 'bin', 'pecot-text-lint.js')
    const file = workDirectory(name)
    writeFileSync(file, content, 'utf8')

    const result = spawnSync(process.execPath, [bin, ...options, file], { encoding: 'utf8' })
    attachOutput(`pecot-text-lint ${options.join(' ')} ${name}`, result.status ?? undefined, result.stdout, result.stderr)

    // 出力行は「file:line:col ruleId message」
    const ruleIds = result.stdout.split('\n').filter(line => /^\S+:\d+:\d+ /.test(line)).map(line => line.split(' ', 2)[1])
    expect(result.status).toBe(1)
    expect(new Set(ruleIds)).toStrictEqual(PARITY_RULES)
  })

  it('drawio_create に禁止文を渡すと、ほかの止める場所と同じ 3 つの規則名を返す', async () => {
    await explains('禁止された表現を含むラベルの図を、`drawio_create` に渡した場合のテストです。返された違反の規則名が、ほかの確認の場所と同じ 3 つになることを確認します。')
    const { input, out } = placeDiagram(`<mxCell id="n1" value="${PARITY_TEXT}" vertex="1" parent="1"/>`)

    const result = await callDrawio(input, out)

    expect(ruleIdsOf(violationsOf(result))).toStrictEqual(PARITY_RULES)
  })

  it('evidence_create に禁止文を渡すと、ほかの止める場所と同じ 3 つの規則名を返す', async () => {
    await explains('禁止された表現を含む `title` を、`evidence_create` に渡した場合のテストです。返された違反の規則名が、ほかの確認の場所と同じ 3 つになることを確認します。')
    const { input, out } = placeEvidence({
      title: PARITY_TEXT,
      createdDate: '2026-10-28',
      items: [{ imagePath: placePng() }],
    })

    const result = await callEvidence(input, out)

    expect(ruleIdsOf(violationsOf(result))).toStrictEqual(PARITY_RULES)
  })

  it('slide_lint の本文（text-constraints/textlint-body）に禁止文があると、ほかの止める場所と同じ 3 つの規則名を返す', async () => {
    await explains('スライドの本文に禁止された表現を含む場合の、`slide_lint` のテストです。`text-constraints/textlint-body` の違反として、ほかの確認の場所と同じ 3 つの規則名が返ることを確認します。')
    expect(await slideLintRuleIds('text-constraints/textlint-body')).toStrictEqual(PARITY_RULES)
  })

  it('slide_lint の frontmatter の表示項目（text-constraints/textlint）に禁止文があると、ほかの止める場所と同じ 3 つの規則名を返す', async () => {
    await explains('スライドの frontmatter の表示項目に禁止された表現を含む場合の、`slide_lint` のテストです。`text-constraints/textlint` の違反として、ほかの確認の場所と同じ 3 つの規則名が返ることを確認します。')
    expect(await slideLintRuleIds('text-constraints/textlint')).toStrictEqual(PARITY_RULES)
  })
})
