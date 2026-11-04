import { createRequire } from 'node:module'
import { moduleInterop } from '@textlint/module-interop'
import type { TextlintKernelRule } from '@textlint/kernel'
import type { TextlintRuleModule, TextlintRuleOptions } from '@textlint/types'

// preset は CJS で、型定義を同梱しないものがある。textlint 自身の config-loader と同じく
// require で読み、moduleInterop で exports.default を剥がし、形を確認してから使う。
const load = createRequire(import.meta.url)

interface TextlintPreset {
  readonly rules: Readonly<Record<string, TextlintRuleModule>>
  readonly rulesConfig: Readonly<Record<string, boolean | TextlintRuleOptions>>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function isPreset(value: unknown): value is TextlintPreset {
  return isRecord(value) && isRecord(value['rules']) && isRecord(value['rulesConfig'])
}

function loadPreset(name: string): TextlintPreset {
  const raw: unknown = load(name)
  const preset = moduleInterop(raw)
  if (!isPreset(preset)) {
    throw new TypeError(`${name} は rules と rulesConfig を持つ preset ではありません`)
  }
  return preset
}

// lint に使う textlint preset のパッケージ名。この順で束ねる。唯一の定義。
export const PRESET_NAMES: readonly string[] = [
  '@textlint-ja/textlint-rule-preset-ai-writing',
  'textlint-rule-preset-ja-technical-writing',
  'textlint-rule-preset-ai-words-ja',
]

// preset から外す規則 ID。
export const EXCLUDED_RULE_IDS: ReadonlySet<string> = new Set(['ja-no-mixed-period'])

// rulesConfig に無い規則は外す。3 preset とも rules と rulesConfig のキー集合は一致する。
function toKernelRules(name: string): TextlintKernelRule[] {
  const preset = loadPreset(name)
  const config = Object.entries(preset.rulesConfig)
  return Object.entries(preset.rules)
    .filter(([ruleId]) => !EXCLUDED_RULE_IDS.has(ruleId))
    .flatMap(([ruleId, rule]) => config.filter(([id]) => id === ruleId).map(([, options]) => ({ ruleId, rule, options })))
}

// kernel は preset を展開しないので手で展開する。モジュール初期化で 1 度だけ作り、同じ配列を返す。
const RULES: TextlintKernelRule[] = PRESET_NAMES.flatMap(name => toKernelRules(name))

export function buildRules(): TextlintKernelRule[] {
  return RULES
}
