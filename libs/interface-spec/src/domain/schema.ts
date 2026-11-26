import { z } from 'zod'

export const EFFECT_TARGETS = ['github', 'aws', 'git', 'file', 'process'] as const
// 意味は MCP の ToolAnnotations に従う。write は足すだけ（destructiveHint: false）、destructive は上書き・削除を含む。
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

// generated.json は書き出しのコマンドが書く。cli・mcp・action は公開しない面では持たない。action は GitHub Actions の action のディレクトリ。
export const generatedEntrySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  surfaces: z.strictObject({
    cli: z.strictObject({ path: z.array(z.string()).min(1) }).optional(),
    mcp: z.strictObject({ tool: z.string() }).optional(),
    action: z.strictObject({ path: z.string() }).optional(),
  }),
  hidden: z.boolean(),
  deprecated: z.boolean(),
  input: jsonSchemaObject,
  cli: z.strictObject({
    positional: z.array(z.string()),
    flags: z.record(z.string(), z.array(z.string())),
    // CLI だけが受け取る入力。値は input.properties の値と同じ JSON Schema。MCP の入力（input）には入れない。
    only: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  mcp: z.strictObject({
    // Tool の最上位の title（表示名）。MCP の面を持つ項目で必須かは validate が確かめる。
    title: z.string().optional(),
    output: jsonSchemaObject.optional(),
    annotations: annotations.optional(),
  }).optional(),
  // action.yml の outputs。キーは output の名前、値は action.yml の description。
  action: z.strictObject({
    outputs: z.record(z.string(), z.string()),
  }).optional(),
})

export const NAME_SEPARATORS = [' ', '_'] as const
// 名前の語は英小文字と数字。区切りを含まない。
export const NAME_WORD_PATTERN = /^[a-z0-9]+$/u

// read_only は読むだけの動詞の印。印の語を名前に持つ項目は、read でない effects を持てない。
const nameWordSchema = z.strictObject({
  word: z.string().regex(NAME_WORD_PATTERN),
  meaning: z.string().trim().min(1),
  read_only: z.literal(true).optional(),
})

// 項目の名前の決まり。positions は語の位置ごとの一覧で、rest が true なら後ろに 1 語以上の自由な語を許す。
export const namesSchema = z.strictObject({
  separator: z.enum(NAME_SEPARATORS),
  positions: z.array(z.array(nameWordSchema).min(1)).min(1),
  rest: z.boolean(),
})

// MCP の静的な resource。並びは書き出す側の順。
const generatedResourceSchema = z.strictObject({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
})

export const generatedFileSchema = z.strictObject({
  format: z.literal(1),
  plugin: z.string(),
  prefix: z.string(),
  names: namesSchema,
  entries: z.array(generatedEntrySchema),
  resources: z.array(generatedResourceSchema).optional(),
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

// constraints の要素は、持っているキーで schema を選んでから parse する（z.union にしない）。
export const conflictConstraintSchema = z.strictObject({ conflicts: z.array(z.string()).min(2) })
export const dependencyConstraintSchema = z.strictObject({ requires: z.record(z.string(), z.array(z.string())) })
// kind の要素は、終了コードが決まっていれば code に書く。
export const exitKindSchema = z.strictObject({ kind: authoredText, code: z.int().min(0).max(255).optional(), when: authoredText })

const runExample = z.strictObject({ run: authoredText, note: authoredText })
// MCP の面を持つ項目の使用例。tools/call の params の arguments に当たる。
const callExample = z.strictObject({ arguments: z.record(z.string(), z.unknown()), note: authoredText })

export const authoredEntrySchema = z.strictObject({
  // summary と arguments は、実装の description と引数の説明（英語）に当たる日本語の文。
  summary: authoredText.optional(),
  arguments: z.record(z.string(), authoredText).optional(),
  constraints: z.array(z.unknown()),
  details: z.array(authoredText),
  stdin: authoredText,
  output,
  // MCP の structuredContent のツールごとの項目の説明。キーは mcp.output の最上位の properties から共通の 4 項目を除いたものとそろえる。
  mcp_output: z.strictObject({
    fields: z.record(z.string(), authoredText),
  }).optional(),
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
  examples: z.array(z.union([runExample, callExample])),
  // CLI の節をページに出す項目の、CLI の使用例。CLI の面を持つ項目だけが書ける。
  // options は、cli.only の入力ごとの説明。
  cli_reference: z.strictObject({
    examples: z.array(runExample).min(1),
    options: z.record(z.string(), authoredText).optional(),
  }).optional(),
  default_notes: z.record(z.string(), authoredText),
  // help は、CLI の --help に出す英語の文。prose が ja の定義書で、上の 3 つの欄の代わりに CLI が読む。
  help: z.strictObject({
    details: z.array(authoredText),
    examples: z.array(runExample),
    default_notes: z.record(z.string(), authoredText),
  }).optional(),
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
  // MCP の structuredContent の、全ツールに共通の項目（kind・detail・log・warnings）の説明。
  common_mcp_output: z.strictObject({
    fields: z.record(z.string(), authoredText),
  }).optional(),
  // キーは generated.json の resources の uri。
  resources: z.record(z.string(), z.strictObject({ summary: authoredText })).optional(),
})

export const targetsSchema = z.strictObject({
  format: z.literal(1),
  plugins: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u), z.strictObject({
    // 定義書（interface/）と glob の起点のディレクトリ。省いたら plugins/<名前>。
    root: z.string().regex(/^[a-z0-9][a-z0-9/-]*$/u).optional(),
    entries: z.enum(ENTRIES_MODES),
    coverage: z.enum(COVERAGE_MODES),
    sources: z.array(z.string()),
    // テストのファイルの glob。links が ID を集める。
    tests: z.array(z.string()),
  })),
})

export type GeneratedEntry = z.infer<typeof generatedEntrySchema>
export type GeneratedFile = z.infer<typeof generatedFileSchema>
export type Names = z.infer<typeof namesSchema>
export type AuthoredEntry = z.infer<typeof authoredEntrySchema>
export type AuthoredFile = z.infer<typeof authoredFileSchema>
export type Targets = z.infer<typeof targetsSchema>
export type Behavior = z.infer<typeof behaviorSchema>
export type Pattern = (typeof PATTERNS)[number]
