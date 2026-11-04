// 冗長表現（ja-no-redundant-expression の dict2）の文を、規則の辞書から実行時に組み立てる。
// ソースに完成形を置かない。違反文を literal で持たない方針に合わせる。
// 組み立てた文は lintText に通し、規則に当たることをここで確かめる。辞書が変わって外れたら原因が分かる形で投げる。
import { createRequire } from 'node:module'

import { lintText } from '@pecot/text-rules'

import { isRecord } from './records.js'

const RULE_ID = 'ja-no-redundant-expression'
const KATAKANA_TO_HIRAGANA = 0x60
const HIRAGANA_GA = 0x30_4C

function toHiragana(text: string): string {
  return Array.from(text, character => String.fromCodePoint((character.codePointAt(0) ?? 0) - KATAKANA_TO_HIRAGANA)).join('')
}

function stringOf(token: unknown, key: string): string | undefined {
  const value = isRecord(token) ? Object.entries(token).find(([name]) => name === key)?.[1] : undefined
  return typeof value === 'string' ? value : undefined
}

function dict2Tokens(): unknown[] {
  const load = createRequire(import.meta.resolve('@pecot/text-rules'))
  const module: unknown = load('textlint-rule-ja-no-redundant-expression/lib/dictionary.js')
  const entries = isRecord(module) ? module['Dictionary'] : undefined
  const candidates: unknown[] = Array.isArray(entries) ? entries : []
  const entry = candidates.find(candidate => isRecord(candidate) && candidate['id'] === 'dict2')
  if (!isRecord(entry) || entry['disabled'] === true || !Array.isArray(entry['tokens'])) {
    throw new TypeError(`${RULE_ID} の辞書 dict2 が見つからないか無効です。辞書の変更を確認してください`)
  }
  const tokens: unknown[] = entry['tokens']
  return tokens
}

// 動詞（する）・名詞（こと）・可能の動詞（できる）を品詞で選ぶ。位置には頼らない。
export async function redundantExpression(): Promise<string> {
  const tokens = dict2Tokens()
  const verb = tokens.map(token => (stringOf(token, 'pos') === '動詞' ? stringOf(token, 'surface_form') : undefined)).find(form => form !== undefined)
  const noun = tokens.map(token => (stringOf(token, 'pos') === '名詞' ? stringOf(token, 'reading') : undefined)).find(form => form !== undefined)
  const possible = tokens.map(token => (stringOf(token, 'pos') === '動詞' ? stringOf(token, 'basic_form') : undefined)).findLast(form => form !== undefined)
  if (verb === undefined || noun === undefined || possible === undefined) {
    throw new TypeError(`${RULE_ID} の辞書 dict2 の tokens から動詞・名詞・可能の動詞を取り出せません。辞書の変更を確認してください`)
  }
  const expression = verb + toHiragana(noun) + String.fromCodePoint(HIRAGANA_GA) + possible.slice(0, -1) + 'ます'
  const findings = await lintText(`設定を変更${expression}。`, 'fragment')
  if (findings.every(finding => finding.ruleId !== RULE_ID)) {
    throw new Error(`組み立てた文が ${RULE_ID} に当たりません。辞書 dict2 の変更を確認してください`)
  }
  return expression
}
