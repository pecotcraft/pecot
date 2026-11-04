import { createRequire } from 'node:module'
import { moduleInterop } from '@textlint/module-interop'
import type { TextlintPluginCreator } from '@textlint/types'
import { withInlineSpansPlugin } from './inline-spans.js'

// plugin には CJS だけのものと、ESM と CJS の両方を持つものがある。
// textlint 自身の config-loader と同じく、同期で読み、moduleInterop で exports.default を剥がし、形を確認してから使う。
const load = createRequire(import.meta.url)

function isPluginCreator(value: unknown): value is TextlintPluginCreator {
  return typeof value === 'object' && value !== null && 'Processor' in value
}

export function loadPlugin(name: string): TextlintPluginCreator {
  const raw: unknown = load(name)
  const plugin = moduleInterop(raw)
  if (!isPluginCreator(plugin)) {
    throw new TypeError(`${name} は Processor を持つ plugin ではありません`)
  }
  return plugin
}

export function loadMarkdownPlugin(): TextlintPluginCreator {
  return loadPlugin('@textlint/textlint-plugin-markdown')
}

export function loadCommentsPlugin(): TextlintPluginCreator {
  return withInlineSpansPlugin(loadPlugin('@cffnpwr/textlint-plugin-comments'))
}
