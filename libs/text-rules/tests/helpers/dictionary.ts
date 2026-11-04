import { createRequire } from 'node:module'
import path from 'node:path'

const load = createRequire(import.meta.url)

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

// ai-words-ja の辞書から、単一トークンの名詞で basic_form を持つ最初の項目の語を取る。
// 違反文は文字列として直書きせず、この語から組み立てる。
export function pickWord(): string {
  const libraryDirectory = path.dirname(load.resolve('textlint-rule-preset-ai-words-ja'))
  const module: unknown = load(path.join(libraryDirectory, 'dictionary.js'))
  const entries = isRecord(module) ? module['dictionary'] : undefined
  if (!Array.isArray(entries)) {
    throw new TypeError('dictionary が配列ではありません')
  }
  for (const entry of entries) {
    const tokens = isRecord(entry) ? entry['tokens'] : undefined
    const token: unknown = Array.isArray(tokens) && tokens.length === 1 ? tokens[0] : undefined
    const form = isRecord(token) && token['pos'] === '名詞' ? token['basic_form'] : undefined
    if (typeof form === 'string') {
      return form
    }
  }
  throw new Error('条件に合う辞書項目がありません')
}
