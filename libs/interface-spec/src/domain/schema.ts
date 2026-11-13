import { z } from 'zod'

export const EFFECT_TARGETS = ['github', 'aws', 'git', 'file', 'process'] as const
export const EFFECT_KINDS = ['read', 'write', 'destructive'] as const
export const PATTERNS = ['ubiquitous', 'event', 'state', 'unwanted', 'optional'] as const
export const OUTPUT_FORMATS = ['text', 'json', 'none'] as const
export const ENTRIES_MODES = ['complete', 'partial'] as const
export const PROSE_LANGUAGES = ['ja', 'en'] as const
export const COVERAGE_MODES = ['off', 'on'] as const

const jsonSchemaObject = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
})

const annotations = z.strictObject({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
})

// generated.json は書き出しのコマンドが書く。cli・mcp は公開しない面では持たない。
export const generatedEntrySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  surfaces: z.strictObject({
    cli: z.strictObject({ path: z.array(z.string()).min(1) }).optional(),
    mcp: z.strictObject({ tool: z.string() }).optional(),
  }),
  hidden: z.boolean(),
  deprecated: z.boolean(),
  input: jsonSchemaObject,
  cli: z.strictObject({
    positional: z.array(z.string()),
    flags: z.record(z.string(), z.array(z.string())),
  }).optional(),
  mcp: z.strictObject({
    output: jsonSchemaObject.optional(),
    annotations: annotations.optional(),
  }).optional(),
})

export const generatedFileSchema = z.strictObject({
  format: z.literal(1),
  plugin: z.string(),
  prefix: z.string(),
  entries: z.array(generatedEntrySchema),
})

// 人が書く文字列の欄。空白だけも空とみなす（trim は検証の中だけで、ファイルには書き戻さない）。
const authoredText = z.string().trim().min(1)

const environmentVariable = z.strictObject({ name: z.string(), effect: authoredText })

export const behaviorSchema = z.strictObject({
  id: z.string(),
  pattern: z.enum(PATTERNS),
  statement: z.string(),
})

const output = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('text'), description: authoredText }),
  // fields は、schema の項目ごとの日本語の説明。schema の description は実装の文字列なので、英語のまま残る。
  z.strictObject({ format: z.literal('json'), description: authoredText, fields: z.record(z.string(), authoredText).optional(), schema: jsonSchemaObject }),
  z.strictObject({ format: z.literal('none') }),
])

// constraints と exit_status の要素は、持っているキーで schema を選んでから parse する（z.union にしない）。
export const conflictConstraintSchema = z.strictObject({ conflicts: z.array(z.string()).min(2) })
export const dependencyConstraintSchema = z.strictObject({ requires: z.record(z.string(), z.array(z.string())) })
export const exitCodeSchema = z.strictObject({ code: z.int().min(0).max(255), when: authoredText })
// kind の要素は、終了コードが決まっていれば code に書く。
export const exitKindSchema = z.strictObject({ kind: authoredText, code: z.int().min(0).max(255).optional(), when: authoredText })

export const authoredEntrySchema = z.strictObject({
  // summary と arguments は、実装の description と引数の説明（英語）に当たる日本語の文。
  summary: authoredText.optional(),
  arguments: z.record(z.string(), authoredText).optional(),
  constraints: z.array(z.unknown()),
  details: z.array(authoredText),
  stdin: authoredText,
  output,
  diagnostics: authoredText,
  environment: z.array(environmentVariable),
  exit_status: z.array(z.unknown()),
  on_error: authoredText,
  effects: z.array(z.strictObject({
    target: z.enum(EFFECT_TARGETS),
    kind: z.enum(EFFECT_KINDS),
    what: authoredText,
  })),
  prerequisites: z.array(authoredText),
  idempotent: z.boolean(),
  examples: z.array(z.strictObject({ run: authoredText, note: authoredText })),
  default_notes: z.record(z.string(), authoredText),
  behaviors: z.array(behaviorSchema).min(1),
})

export const authoredFileSchema = z.strictObject({
  format: z.literal(1),
  plugin: z.string(),
  // 人が書く欄の言語。省いたら en。statement は、いつも日本語。
  prose: z.enum(PROSE_LANGUAGES).optional(),
  environment: z.array(environmentVariable),
  entries: z.record(z.string(), authoredEntrySchema),
  common_behaviors: z.array(behaviorSchema),
})

export const targetsSchema = z.strictObject({
  format: z.literal(1),
  plugins: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u), z.strictObject({
    entries: z.enum(ENTRIES_MODES),
    coverage: z.enum(COVERAGE_MODES),
    sources: z.array(z.string()),
    // テストのファイルの glob。links が ID を集める。
    tests: z.array(z.string()),
  })),
})

export type GeneratedEntry = z.infer<typeof generatedEntrySchema>
export type GeneratedFile = z.infer<typeof generatedFileSchema>
export type AuthoredEntry = z.infer<typeof authoredEntrySchema>
export type AuthoredFile = z.infer<typeof authoredFileSchema>
export type Targets = z.infer<typeof targetsSchema>
export type Behavior = z.infer<typeof behaviorSchema>
export type Pattern = (typeof PATTERNS)[number]
