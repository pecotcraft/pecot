// テーマの pecot 用の宣言（pecot-theme.json）を読む。
// 形の契約は specs/016-slidev-theme-split/contracts/theme-declaration.md。
// CLI・MCP・hooks・lint の規則は、ここの結果を受け取る。

import path from 'node:path'

import { z } from 'zod'

import { isRecord } from '../_shared/json.js'
import { DEFAULT_THEME_DECLARATION } from './defaults.js'
import { DECK_LINT_RULE_IDS } from './deck-lint-rules.js'
import type { ThemeFiles } from './ports.js'

export const THEME_DECLARATION_FILE_NAME = 'pecot-theme.json'
export const SUPPORTED_SCHEMA = 1

// 誤りの文言に添える、契約の節の案内。
const CONTRACT_FILE = 'contracts/theme-declaration.md'
const SHAPE_SECTION = `the \`${THEME_DECLARATION_FILE_NAME}\` section of ${CONTRACT_FILE}`

export type LintSeverity = 'error' | 'warn' | 'off'

export interface ResolvedThemeDeclaration {
  readonly schema: number
  readonly slide: { readonly width: number, readonly height: number }
  readonly fonts: {
    readonly body: readonly string[]
    readonly heading: readonly string[]
    readonly eastAsian?: string
  }
  readonly fontSizes: {
    readonly heading: number
    readonly headingSm: number
    readonly body: number
    readonly bodySm: number
    readonly label: number
  }
  readonly pptx: { readonly eastAsianFont?: string, readonly linkColor?: string }
  readonly lint: { readonly rules: Readonly<Record<string, LintSeverity>> }
  readonly layouts: { readonly references: string }
  readonly drawio: {
    readonly panels: Readonly<Record<string, { readonly width: number, readonly height: number }>>
    readonly markerLayouts: readonly string[]
  }
}

export interface ThemeDeclarationResult {
  readonly declaration: ResolvedThemeDeclaration
  readonly warnings: readonly string[]
}

export type ThemeDeclarationErrorReason = 'invalid-shape' | 'unknown-rule'

export class ThemeDeclarationError extends Error {
  constructor(message: string, readonly reason: ThemeDeclarationErrorReason) {
    super(message)
    this.name = 'ThemeDeclarationError'
  }
}

const positive = z.number().positive()
const size = z.strictObject({ width: positive, height: positive })
const severity = z.enum(['error', 'warn', 'off'])
const name = z.string().min(1)
const names = z.array(name).min(1)

// 最上位以下の各項目は任意。省いた分は resolve で既定値で埋める。
const fontsSchema = z.object({ body: names.optional(), heading: names.optional(), eastAsian: name.optional() })
const fontSizesSchema = z.object({
  heading: positive.optional(),
  headingSm: positive.optional(),
  body: positive.optional(),
  bodySm: positive.optional(),
  label: positive.optional(),
})
const pptxSchema = z.object({
  eastAsianFont: name.optional(),
  linkColor: z.string().regex(/^[\da-f]{6}$/iu, 'must be 6 hex digits').optional(),
})
const lintSchema = z.object({ rules: z.record(z.string(), severity).optional() })
const layoutsSchema = z.object({ references: name.optional() })
const drawioSchema = z.object({
  panels: z.record(z.string(), size).optional(),
  markerLayouts: z.array(name).optional(),
})

const declarationSchema = z.object({
  schema: z.literal(SUPPORTED_SCHEMA),
  slide: size.optional(),
  fonts: fontsSchema.optional(),
  fontSizes: fontSizesSchema.optional(),
  pptx: pptxSchema.optional(),
  lint: lintSchema.optional(),
  layouts: layoutsSchema.optional(),
  drawio: drawioSchema.optional(),
})

type ParsedDeclaration = z.infer<typeof declarationSchema>

const KNOWN_RULES: ReadonlySet<string> = new Set(DECK_LINT_RULE_IDS)

/**
JSON を読んだ unknown 値を宣言として検証し、省いた項目を既定値で埋めて返す。
- 知らない `schema` は警告し、宣言の中身を使わず既定値で続ける。
- `lint.rules` の知らない規則名は `unknown-rule` で止める。
- 形の誤りは、誤りの項目名を含めて `invalid-shape` で止める。
*/
export function parseThemeDeclaration(raw: unknown): ThemeDeclarationResult {
  if (!isRecord(raw)) {
    throw new ThemeDeclarationError(`${THEME_DECLARATION_FILE_NAME} must be an object (see ${SHAPE_SECTION})`, 'invalid-shape')
  }

  const { schema } = raw
  if (typeof schema === 'number' && schema !== SUPPORTED_SCHEMA) {
    return {
      declaration: DEFAULT_THEME_DECLARATION,
      warnings: [
        `${THEME_DECLARATION_FILE_NAME} schema ${String(schema)} is not supported (supported: ${String(SUPPORTED_SCHEMA)}); ignoring the declaration and continuing with the defaults`,
      ],
    }
  }

  const parsed = declarationSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.map(String).join('.') || '(top level)'}: ${issue.message}`)
      .join('; ')
    throw new ThemeDeclarationError(`invalid shape of ${THEME_DECLARATION_FILE_NAME}: ${detail} (see ${SHAPE_SECTION})`, 'invalid-shape')
  }

  const unknownRules = Object.keys(parsed.data.lint?.rules ?? {}).filter(id => !KNOWN_RULES.has(id))
  if (unknownRules.length > 0) {
    throw new ThemeDeclarationError(
      `lint.rules in ${THEME_DECLARATION_FILE_NAME} has rules the deck lint does not have: ${unknownRules.join(', ')} (see the "lint.rules" part of ${SHAPE_SECTION})`,
      'unknown-rule',
    )
  }

  return { declaration: resolve(parsed.data), warnings: [] }
}

/**
`<themeRoot>/pecot-theme.json` を読む。無ければ警告して既定値で続ける。
*/
export async function readThemeDeclaration(files: ThemeFiles, themeRoot: string): Promise<ThemeDeclarationResult> {
  const filePath = path.join(themeRoot, THEME_DECLARATION_FILE_NAME)
  const text = await files.readText(filePath)
  if (text === undefined) {
    return {
      declaration: DEFAULT_THEME_DECLARATION,
      warnings: [`theme ${themeRoot} has no ${THEME_DECLARATION_FILE_NAME} declaration; continuing with the defaults`],
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ThemeDeclarationError(`cannot read ${filePath} as JSON: ${reason} (see ${SHAPE_SECTION})`, 'invalid-shape')
  }
  return parseThemeDeclaration(raw)
}

// zod の推論型は配列が mutable なため、readonly 引数の規則から外す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function resolve(data: ParsedDeclaration): ResolvedThemeDeclaration {
  const defaults = DEFAULT_THEME_DECLARATION
  const eastAsian = data.fonts?.eastAsian ?? defaults.fonts.eastAsian
  const eastAsianFont = data.pptx?.eastAsianFont ?? defaults.pptx.eastAsianFont
  const linkColor = data.pptx?.linkColor ?? defaults.pptx.linkColor
  return {
    schema: SUPPORTED_SCHEMA,
    slide: data.slide ?? defaults.slide,
    fonts: {
      body: data.fonts?.body ?? defaults.fonts.body,
      heading: data.fonts?.heading ?? defaults.fonts.heading,
      ...(eastAsian !== undefined && { eastAsian }),
    },
    fontSizes: {
      heading: data.fontSizes?.heading ?? defaults.fontSizes.heading,
      headingSm: data.fontSizes?.headingSm ?? defaults.fontSizes.headingSm,
      body: data.fontSizes?.body ?? defaults.fontSizes.body,
      bodySm: data.fontSizes?.bodySm ?? defaults.fontSizes.bodySm,
      label: data.fontSizes?.label ?? defaults.fontSizes.label,
    },
    pptx: {
      ...(eastAsianFont !== undefined && { eastAsianFont }),
      ...(linkColor !== undefined && { linkColor }),
    },
    lint: { rules: data.lint?.rules ?? defaults.lint.rules },
    layouts: { references: data.layouts?.references ?? defaults.layouts.references },
    drawio: {
      panels: data.drawio?.panels ?? defaults.drawio.panels,
      markerLayouts: data.drawio?.markerLayouts ?? defaults.drawio.markerLayouts,
    },
  }
}
