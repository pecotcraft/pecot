// 冗長表現（ja-no-redundant-expression の dict2）の文を、規則の辞書から実行時に組み立てる。
// ソースに完成形を置かない。違反文を literal で持たない方針に合わせる。
// 組み立てた文は lintText に通し、規則に当たることをここで確かめる。辞書が変わって外れたら原因が分かる形で投げる。
import { createRequire } from 'node:module';

import { lintText } from '@pecot/text-rules';

interface Token {
  pos?: string;
  surface_form?: unknown;
  reading?: unknown;
  basic_form?: unknown;
}

interface Entry {
  id: string;
  disabled?: boolean;
  tokens: Token[];
}

const RULE_ID = 'ja-no-redundant-expression';
const KATAKANA_TO_HIRAGANA = 0x60;
const HIRAGANA_GA = 0x30_4c;

function toHiragana(text: string): string {
  return Array.from(text, (character) => String.fromCodePoint((character.codePointAt(0) ?? 0) - KATAKANA_TO_HIRAGANA)).join('');
}

function dict2Tokens(): Token[] {
  const load = createRequire(import.meta.resolve('@pecot/text-rules'));
  const { Dictionary } = load('textlint-rule-ja-no-redundant-expression/lib/dictionary.js') as { Dictionary: Entry[] };
  const entry = Dictionary.find((candidate) => candidate.id === 'dict2');
  if (!entry || entry.disabled === true || !Array.isArray(entry.tokens)) {
    throw new TypeError(`${RULE_ID} の辞書 dict2 が見つからないか無効です。辞書の変更を確認してください`);
  }
  return entry.tokens;
}

function stringsOf(tokens: Token[], pos: string, key: 'surface_form' | 'reading' | 'basic_form'): string[] {
  return tokens.flatMap((token) => (token.pos === pos && typeof token[key] === 'string' ? [token[key]] : []));
}

// 動詞（する）・名詞（こと）・可能の動詞（できる）を品詞で選ぶ。位置には頼らない。
export async function redundantExpression(): Promise<string> {
  const tokens = dict2Tokens();
  const verb = stringsOf(tokens, '動詞', 'surface_form')[0];
  const noun = stringsOf(tokens, '名詞', 'reading')[0];
  const possible = stringsOf(tokens, '動詞', 'basic_form').at(-1);
  if (verb === undefined || noun === undefined || possible === undefined) {
    throw new TypeError(`${RULE_ID} の辞書 dict2 の tokens から動詞・名詞・可能の動詞を取り出せません。辞書の変更を確認してください`);
  }
  const expression = verb + toHiragana(noun) + String.fromCodePoint(HIRAGANA_GA) + possible.slice(0, -1) + 'ます';
  const findings = await lintText(`設定を変更${expression}。`, 'fragment');
  if (findings.every((finding) => finding.ruleId !== RULE_ID)) {
    throw new Error(`組み立てた文が ${RULE_ID} に当たりません。辞書 dict2 の変更を確認してください`);
  }
  return expression;
}
