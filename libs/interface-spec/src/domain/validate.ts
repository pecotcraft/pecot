import type { z } from 'zod'
import { hasJapanese, isPatternMatch } from './ears.js'
import { checkEnvironment, isValidEnvironmentName } from './environment-names.js'
import type { SourceFile } from './environment-names.js'
import { sortFindings } from './finding.js'
import type { Finding } from './finding.js'
import { issuesToFindings, pathOf } from './issues.js'
import type { FileKind } from './issues.js'
import {
  authoredFileSchema,
  behaviorSchema,
  conflictConstraintSchema,
  exitKindSchema,
  generatedFileSchema,
  dependencyConstraintSchema,
  NAME_WORD_PATTERN,
  targetsSchema,
} from './schema.js'
import { compareText, isRecord } from './utility.js'
import type { AuthoredEntry, AuthoredFile, Behavior, GeneratedEntry, GeneratedFile, Names, Targets } from './schema.js'

export const TARGETS_PATH = 'libs/interface-spec/targets.json'

export interface SyntaxProblem {
  readonly line?: number
  readonly message: string
}

export type FileState
  = | { readonly kind: 'missing' }
    | { readonly kind: 'syntax', readonly problems: readonly SyntaxProblem[] }
    | { readonly kind: 'ok', readonly data: unknown }

export interface PluginInput {
  // plugins/ の下のディレクトリ名
  readonly name: string
  readonly dirExists: boolean
  readonly mode: 'complete' | 'partial'
  readonly generated: FileState
  readonly authored: FileState
  // mode が complete のときだけ読む。
  readonly sources: readonly SourceFile[]
}

type TextPair = readonly [string, string]

function quote(value: string): string {
  return JSON.stringify(value)
}

function stateFindings(file: string, state: FileState): Finding[] {
  if (state.kind === 'missing') return [{ file, reason: 'file is missing' }]
  if (state.kind === 'ok') return []
  return state.problems.map(problem => ({
    file,
    ...(problem.line !== undefined && { line: problem.line }),
    reason: problem.message,
  }))
}

function parseWith<Schema extends z.ZodType>(schema: Schema, file: string, data: unknown, kind: FileKind): { readonly data?: z.infer<Schema>, readonly findings: Finding[] } {
  const result = schema.safeParse(data)
  return result.success ? { data: result.data, findings: [] } : { findings: issuesToFindings(result.error.issues, file, data, kind) }
}

export function validateTargets(state: FileState): { readonly targets?: Targets, readonly findings: Finding[] } {
  if (state.kind !== 'ok') return { findings: stateFindings(TARGETS_PATH, state) }
  const parsed = parseWith(targetsSchema, TARGETS_PATH, state.data, 'targets')
  return parsed.data === undefined ? { findings: parsed.findings } : { targets: parsed.data, findings: parsed.findings }
}

// 持っているキーで schema を選ぶ。z.union にすると、全部の枝の issue が入れ子で返る。
function selectConstraint(value: unknown): z.ZodType | undefined {
  if (!isRecord(value)) return undefined
  if (Object.hasOwn(value, 'conflicts')) return conflictConstraintSchema
  return Object.hasOwn(value, 'requires') ? dependencyConstraintSchema : undefined
}

function elementFindings(data: unknown, file: string, entries: Readonly<Record<string, unknown>>): Finding[] {
  const findings: Finding[] = []
  const selectors = [
    { field: 'constraints', select: selectConstraint, expected: 'an object with "conflicts" or "requires"' },
    { field: 'exit_status', select: (value: unknown) => isRecord(value) ? exitKindSchema : undefined, expected: 'an object with "kind"' },
  ] as const
  for (const [id, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue
    for (const { field, select, expected } of selectors) {
      const list = entry[field]
      if (!Array.isArray(list)) continue
      for (const [index, element] of list.entries()) {
        const schema = select(element)
        const path = ['entries', id, field, index]
        if (schema === undefined) {
          const issue: z.core.$ZodIssue = { code: 'custom', path, message: `must be ${expected}`, input: element }
          findings.push(...issuesToFindings([issue], file, data, 'authored'))
          continue
        }
        const result = schema.safeParse(element)
        if (result.success) continue
        const rebased = result.error.issues.map((issue): z.core.$ZodIssue => ({ ...issue, path: [...path, ...pathOf(issue)] }))
        findings.push(...issuesToFindings(rebased, file, data, 'authored'))
      }
    }
  }
  return findings
}

type Prose = AuthoredFile['prose']

// prose は人が書く欄の言語。generated.json の欄は、いつも英語。
function japaneseFindings(file: string, scope: string | undefined, texts: readonly TextPair[], prose: NonNullable<Prose> = 'en'): Finding[] {
  const isJapanese = prose === 'ja'
  return texts.filter(([, text]) => hasJapanese(text) !== isJapanese).map(([field]) => ({
    file,
    ...(scope !== undefined && { scope }),
    field,
    reason: isJapanese ? 'has no Japanese text (write Japanese)' : 'contains Japanese text (write English)',
  }))
}

// 形が崩れていても、prose が 'ja' のときだけ日本語とみなす。
function proseOf(data: unknown): NonNullable<Prose> {
  return isRecord(data) && data['prose'] === 'ja' ? 'ja' : 'en'
}

// 決まった値は、書かなくてよい欄の既定値。言語の確認から除く。
const FIXED_VALUES: Readonly<Record<string, string>> = { stdin: 'none', diagnostics: 'default', on_error: 'default' }

function inputDescriptions(value: unknown, path: string): TextPair[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => inputDescriptions(item, `${path}[${String(index)}]`))
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'description' && typeof child === 'string' ? [[`${path}.description`, child] as const] : inputDescriptions(child, `${path}.${key}`))
}

// 大文字と数字を - でつないだ 2 つ以上の部分。
function isIdentifier(id: string): boolean {
  const parts = id.split('-')
  return parts.length >= 2 && parts.every(part => /^[A-Z0-9]+$/u.test(part))
}

function checkGenerated(file: string, name: string, data: GeneratedFile): Finding[] {
  const findings: Finding[] = []
  if (data.plugin !== name) {
    findings.push({ file, field: 'plugin', reason: `${quote(data.plugin)} does not match the directory name ${quote(name)}` })
  }
  if (!/^[A-Z][A-Z0-9]*$/u.test(data.prefix)) {
    findings.push({ file, field: 'prefix', reason: `${quote(data.prefix)} must be upper-case letters and digits` })
  }
  const seen = new Set<string>()
  for (const entry of data.entries) {
    const scope = entry.id
    if (!scope.startsWith(`${data.prefix}-`) || !isIdentifier(scope)) {
      findings.push({ file, scope, field: 'id', reason: `must start with "${data.prefix}-" and use only A-Z, 0-9 and "-"` })
    }
    if (seen.has(scope)) findings.push({ file, scope, field: 'id', reason: 'is defined more than once' })
    seen.add(scope)
    if (entry.surfaces.cli === undefined && entry.surfaces.mcp === undefined) {
      findings.push({ file, scope, field: 'surfaces', reason: 'must have cli or mcp' })
    }
    if (entry.surfaces.mcp !== undefined && entry.mcp?.output?.['additionalProperties'] !== false) {
      findings.push({ file, scope, field: 'mcp.output', reason: 'is not a closed type (declare every field the tool returns and set additionalProperties to false)' })
    }
    const title = entry.mcp?.title
    if (entry.surfaces.mcp !== undefined && (title === undefined || title.trim() === '')) {
      findings.push({ file, scope, field: 'mcp.title', reason: 'is missing (give the tool a display name in English)' })
    }
    findings.push(
      ...japaneseFindings(file, scope, [
        ['name', entry.name],
        ['description', entry.description],
        ...(title === undefined ? [] : [['mcp.title', title] as const]),
        ...inputDescriptions(entry.input, 'input'),
        ...inputDescriptions(entry.cli?.only ?? {}, 'cli.only'),
      ]),
      ...inputNameFindings(file, scope, entry),
      ...nameRuleFindings(file, scope, entry.name, data.names),
    )
  }
  return [...duplicateWordFindings(file, data.names), ...findings, ...resourceFindings(file, data)]
}

function resourceFindings(file: string, data: GeneratedFile): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  const resources = data.resources ?? []
  for (const resource of resources) {
    const scope = resource.uri
    if (seen.has(scope)) findings.push({ file, scope, field: 'uri', reason: 'is defined more than once' })
    seen.add(scope)
    const texts: TextPair[] = [['name', resource.name], ...(resource.description === undefined ? [] : [['description', resource.description] as const])]
    findings.push(...japaneseFindings(file, scope, texts))
  }
  return findings
}

function duplicateWordFindings(file: string, names: Names): Finding[] {
  return names.positions.flatMap((words, index) => {
    const listed = words.map(item => item.word)
    const duplicated = [...new Set(listed.filter((word, at) => listed.indexOf(word) !== at))]
    return duplicated.map(word => ({ file, field: `names.positions[${String(index)}]`, reason: `${quote(word)} is listed more than once` }))
  })
}

// 名前を区切りで語に分け、語の数と位置ごとの一覧を比べる。rest の語は形だけを見る。
function nameRuleFindings(file: string, scope: string, name: string, names: Names): Finding[] {
  const words = name.split(names.separator)
  const fixed = names.positions.length
  const finding = (reason: string): Finding => ({ file, scope, field: 'name', reason })
  const findings: Finding[] = []
  if (names.rest ? words.length <= fixed : words.length !== fixed) {
    const expected = names.rest ? `${String(fixed + 1)} or more` : String(fixed)
    findings.push(finding(`${quote(name)} has ${String(words.length)} word(s) but names expects ${expected}`))
  }
  for (const [index, word] of words.entries()) {
    const listed = names.positions[index]
    if (listed === undefined) {
      if (names.rest && !NAME_WORD_PATTERN.test(word)) findings.push(finding(`word ${String(index + 1)} ${quote(word)} must be lower-case letters and digits`))
    }
    else if (listed.every(item => item.word !== word)) {
      findings.push(finding(`word ${String(index + 1)} ${quote(word)} is not in names.positions[${String(index)}]`))
    }
  }
  return findings
}

function cliOnlyNames(entry: GeneratedEntry): string[] {
  return Object.keys(entry.cli?.only ?? {})
}

function inputNameFindings(file: string, scope: string, entry: GeneratedEntry): Finding[] {
  const input = new Set(Object.keys(entry.input.properties))
  const only = cliOnlyNames(entry)
  const known = new Set([...input, ...only])
  const flags = Object.keys(entry.cli?.flags ?? {})
  const references = [
    ...(entry.cli?.positional ?? []).map(name => ['cli.positional', name] as const),
    ...flags.map(name => ['cli.flags', name] as const),
  ]
  return [
    ...references.filter(([, name]) => !known.has(name)).map(([field, name]) => ({
      file, scope, field, reason: `unknown input name ${quote(name)}`,
    })),
    ...only.filter(name => input.has(name)).map(name => ({
      file, scope, field: 'cli.only', reason: `${quote(name)} is also in input (remove it from one; input is the MCP input)`,
    })),
    ...only.filter(name => !flags.includes(name)).map(name => ({
      file, scope, field: 'cli.only', reason: `${quote(name)} is not in cli.flags (give the CLI-only input a flag)`,
    })),
  ]
}

function annotationFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  const hints = generated.mcp?.annotations
  if (hints === undefined) return []
  const kinds = new Set(entry.effects.map(effect => effect.kind))
  const finding = (reason: string): Finding => ({ file, scope, reason })
  const findings: Finding[] = []
  const writes = (['write', 'destructive'] as const).filter(kind => kinds.has(kind))
  if (hints.readOnlyHint === true) {
    findings.push(...writes.map(kind => finding(`effects has kind "${kind}" but annotations.readOnlyHint is true`)))
  }
  else if (hints.readOnlyHint === false && writes.length === 0) {
    findings.push(finding('effects has no kind "write" or "destructive" but annotations.readOnlyHint is false'))
  }
  if (hints.destructiveHint === true && !kinds.has('destructive')) {
    findings.push(finding('effects has no kind "destructive" but annotations.destructiveHint is true'))
  }
  else if (hints.destructiveHint === false && kinds.has('destructive')) {
    findings.push(finding('effects has kind "destructive" but annotations.destructiveHint is false'))
  }
  if (hints.idempotentHint !== undefined && hints.idempotentHint !== entry.idempotent) {
    findings.push(finding(`idempotent is ${String(entry.idempotent)} but annotations.idempotentHint is ${String(hints.idempotentHint)}`))
  }
  return findings
}

// 振る舞いの項目の ID は <idPrefix>-<2 桁の番号>。
function isBehaviorId(id: string, idPrefix: string): boolean {
  return id.startsWith(`${idPrefix}-`) && /^\d{2}$/u.test(id.slice(idPrefix.length + 1))
}

function behaviorFindings(file: string, behaviors: readonly Behavior[], scope: string | undefined, idPrefix: string, list: string): Finding[] {
  const findings: Finding[] = []
  for (const [index, behavior] of behaviors.entries()) {
    if (!isBehaviorId(behavior.id, idPrefix)) {
      findings.push({
        file,
        ...(scope !== undefined && { scope }),
        field: `${list}[${String(index)}].id`,
        reason: `${quote(behavior.id)} must be ${quote(`${idPrefix}-NN`)} (NN is 2 digits)`,
      })
    }
    // 空の判定は zod の trim と同じ String.prototype.trim。
    if (behavior.statement.trim() === '') {
      findings.push({ file, scope: behavior.id, field: 'statement', reason: 'is empty' })
      continue
    }
    if (!hasJapanese(behavior.statement)) {
      findings.push({ file, scope: behavior.id, field: 'statement', reason: 'has no Japanese text (write Japanese)' })
    }
    else if (!isPatternMatch(behavior.pattern, behavior.statement)) {
      findings.push({ file, scope: behavior.id, reason: `statement does not match pattern ${quote(behavior.pattern)}` })
    }
  }
  return findings
}

function namesFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  const known = new Set(Object.keys(generated.input.properties))
  const unknown = (field: string, names: readonly string[]): Finding[] => names.filter(name => !known.has(name)).map(name => ({
    file, scope, field, reason: `unknown input name ${quote(name)}`,
  }))
  const findings = unknown('default_notes', Object.keys(entry.default_notes))
  for (const [index, element] of entry.constraints.entries()) {
    const schema = selectConstraint(element)
    const conflicts = schema === conflictConstraintSchema ? conflictConstraintSchema.safeParse(element) : undefined
    const dependency = schema === dependencyConstraintSchema ? dependencyConstraintSchema.safeParse(element) : undefined
    if (conflicts?.success === true) findings.push(...unknown(`constraints[${String(index)}].conflicts`, conflicts.data.conflicts))
    const requires = dependency?.success === true ? dependency.data.requires : {}
    findings.push(...unknown(`constraints[${String(index)}].requires`, [...Object.keys(requires), ...Object.values(requires).flat()]))
  }
  return findings
}

function exitTexts(entry: AuthoredEntry): TextPair[] {
  return entry.exit_status.flatMap((element, index) => {
    const parsed = exitKindSchema.safeParse(element)
    return parsed.success ? [[`exit_status[${String(index)}].when`, parsed.data.when] as const] : []
  })
}

function hasSameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

// CLI の --help は英語で出す。prose が ja で CLI の面がある項目は、help に英語の文を持つ。
function helpFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry, prose: NonNullable<Prose>): Finding[] {
  const finding = (reason: string, field = 'help'): Finding => ({ file, scope, field, reason })
  const { help } = entry
  if (prose !== 'ja') return help === undefined ? [] : [finding('is only for prose "ja" (remove it; --help reads details, examples and default_notes)')]
  if (help === undefined) return generated.surfaces.cli === undefined ? [] : [finding('is missing (--help reads it; write details, examples and default_notes in English)')]
  const texts: TextPair[] = [
    ...help.details.map((text, index) => [`help.details[${String(index)}]`, text] as const),
    ...help.examples.map((example, index) => [`help.examples[${String(index)}].note`, example.note] as const),
    ...Object.entries(help.default_notes).map(([name, text]) => [`help.default_notes.${name}`, text] as const),
  ]
  const findings = japaneseFindings(file, scope, texts)
  // MCP の面を持つ項目の examples は MCP の例なので、CLI の例は cli_reference にあるときだけ比べる。
  const cliExamples = entry.cli_reference?.examples ?? (generated.surfaces.mcp === undefined ? runExamples(entry) : undefined)
  if (cliExamples !== undefined && !hasSameNames(help.examples.map(example => example.run), cliExamples.map(example => example.run))) {
    const source = entry.cli_reference === undefined ? 'examples' : 'cli_reference.examples'
    findings.push(finding(`must have the same run values, in the same order, as ${source}`, 'help.examples'))
  }
  if (!hasSameNames(Object.keys(help.default_notes).toSorted(compareText), Object.keys(entry.default_notes).toSorted(compareText))) {
    findings.push(finding('must have the same input names as default_notes', 'help.default_notes'))
  }
  return findings
}

type Example = AuthoredEntry['examples'][number]
type RunExample = Extract<Example, { run: string }>

function runExamples(entry: AuthoredEntry): RunExample[] {
  return entry.examples.filter((example): example is RunExample => 'run' in example)
}

// MCP の面を持つ項目の使用例は arguments の形で、キーは input にあり、required を全部持つ。面の無い項目は run の形。
function exampleFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  const hasMcp = generated.surfaces.mcp !== undefined
  const known = new Set(Object.keys(generated.input.properties))
  const only = new Set(cliOnlyNames(generated))
  const listed: unknown = generated.input['required']
  const required = Array.isArray(listed) ? listed.filter((name): name is string => typeof name === 'string') : []
  return entry.examples.flatMap((example, index): Finding[] => {
    const field = `examples[${String(index)}]`
    if (!('arguments' in example)) {
      return hasMcp ? [{ file, scope, field, reason: 'must be an MCP call (write arguments instead of run)' }] : []
    }
    if (!hasMcp) return [{ file, scope, field, reason: 'must be a command line (write run instead of arguments; the entry has no MCP surface)' }]
    const names = Object.keys(example.arguments)
    return [
      ...names.filter(name => !known.has(name)).map(name => ({
        file, scope, field: `${field}.arguments`, reason: only.has(name) ? cliOnlyReason(name) : `unknown input name ${quote(name)}`,
      })),
      ...required.filter(name => !names.includes(name)).map(name => ({ file, scope, field: `${field}.arguments`, reason: `is missing the required input ${quote(name)}` })),
    ]
  })
}

function cliOnlyReason(name: string): string {
  return `${quote(name)} is in cli.only (remove it; only the CLI takes it)`
}

// cli.only の入力は MCP の欄に書かない。CLI の節（cli_reference）を持つ項目は、cli_reference.options にその説明を書く。
function cliOnlyInputFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  const only = cliOnlyNames(generated)
  const listed = (field: string, names: readonly string[]): Finding[] => names.filter(name => only.includes(name)).map(name => ({
    file, scope, field, reason: cliOnlyReason(name),
  }))
  const findings = [
    ...listed('arguments', Object.keys(entry.arguments ?? {})),
    ...listed('mcp_output.fields', Object.keys(entry.mcp_output?.fields ?? {})),
  ]
  const reference = entry.cli_reference
  if (reference === undefined) return findings
  const options = Object.keys(reference.options ?? {})
  const finding = (reason: string): Finding => ({ file, scope, field: 'cli_reference.options', reason })
  const missing = only.filter(name => !options.includes(name))
  const unknown = options.filter(name => !only.includes(name))
  return [
    ...findings,
    ...(missing.length === 0 ? [] : [finding(`is missing ${missing.map(name => quote(name)).join(', ')} (present in cli.only)`)]),
    ...(unknown.length === 0 ? [] : [finding(`has ${unknown.map(name => quote(name)).join(', ')} not in cli.only (remove it)`)]),
  ]
}

// CLI の節（cli_reference）と終了コード（exit_status[].code）は、CLI の面を持つ項目だけが持つ。
function cliOnlyFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  if (generated.surfaces.cli !== undefined) return []
  const codes = entry.exit_status.entries().filter(([, element]) => {
    const parsed = exitKindSchema.safeParse(element)
    return parsed.success && parsed.data.code !== undefined
  }).map(([index]) => index).toArray()
  return [
    ...(entry.cli_reference === undefined ? [] : [{ file, scope, field: 'cli_reference', reason: 'is only for entries with a CLI surface (remove it)' }]),
    ...codes.map(index => ({ file, scope, field: `exit_status[${String(index)}].code`, reason: 'is only for entries with a CLI surface (remove it)' })),
  ]
}

function readOnlyWordOf(name: string, names: Names): string | undefined {
  return name.split(names.separator).find((word, index) => names.positions[index]?.some(item => item.word === word && item.read_only === true))
}

function readOnlyFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry, names: Names): Finding[] {
  const word = readOnlyWordOf(generated.name, names)
  if (word === undefined) return []
  return entry.effects.entries().filter(([, effect]) => effect.kind !== 'read').map(([index, effect]) => ({
    file, scope, field: `effects[${String(index)}]`, reason: `has kind ${quote(effect.kind)} but ${quote(word)} is a read-only word in names`,
  })).toArray()
}

// structuredContent の最上位に、ツールの項目と並べて置く全ツールに共通の項目。ツールの項目ごとの説明には数えない
const COMMON_OUTPUT_FIELDS: ReadonlySet<string> = new Set(['kind', 'detail', 'log', 'warnings'])

// MCP の面を持つ項目は、mcp_output に mcp.output のツールの項目をすべて書く。mcp.output が閉じた型かは checkGenerated が確かめる
function mcpOutputFindings(file: string, scope: string, entry: AuthoredEntry, generated: GeneratedEntry): Finding[] {
  if (generated.surfaces.mcp === undefined) {
    return entry.mcp_output === undefined ? [] : [{ file, scope, field: 'mcp_output', reason: 'is only for entries with an MCP surface (remove it)' }]
  }
  if (entry.mcp_output === undefined) {
    return [{ file, scope, field: 'mcp_output', reason: 'is missing (write each tool field in mcp.output, or an empty fields when it returns none)' }]
  }
  const finding = (reason: string): Finding => ({ file, scope, field: 'mcp_output.fields', reason })
  const expected = Object.keys(generated.mcp?.output?.properties ?? {}).filter(name => !COMMON_OUTPUT_FIELDS.has(name)).toSorted(compareText)
  const written = Object.keys(entry.mcp_output.fields).toSorted(compareText)
  const missing = expected.filter(name => !written.includes(name))
  const unknown = written.filter(name => !expected.includes(name))
  return [
    ...(missing.length === 0 ? [] : [finding(`is missing ${missing.map(name => quote(name)).join(', ')} (present in mcp.output)`)]),
    ...(unknown.length === 0 ? [] : [finding(`has ${unknown.map(name => quote(name)).join(', ')} not in mcp.output (remove it)`)]),
  ]
}

// MCP の面を持つ項目があるプラグインは、common_mcp_output に共通の 4 項目の説明を書く
function commonMcpOutputFindings(file: string, authored: AuthoredFile, generated: GeneratedFile): Finding[] {
  const hasMcp = generated.entries.some(entry => entry.surfaces.mcp !== undefined)
  const common = authored.common_mcp_output
  if (common === undefined) {
    return hasMcp ? [{ file, field: 'common_mcp_output', reason: 'is missing (write kind, detail, log and warnings in fields)' }] : []
  }
  if (!hasMcp) return [{ file, field: 'common_mcp_output', reason: 'is only for plugins with an MCP surface (remove it)' }]
  const finding = (reason: string): Finding => ({ file, field: 'common_mcp_output.fields', reason })
  const expected = [...COMMON_OUTPUT_FIELDS].toSorted(compareText)
  const written = Object.keys(common.fields).toSorted(compareText)
  const missing = expected.filter(name => !written.includes(name))
  const unknown = written.filter(name => !expected.includes(name))
  return [
    ...(missing.length === 0 ? [] : [finding(`is missing ${missing.map(name => quote(name)).join(', ')}`)]),
    ...(unknown.length === 0 ? [] : [finding(`has ${unknown.map(name => quote(name)).join(', ')} that is not a common field (remove it)`)]),
    ...japaneseFindings(file, undefined, Object.entries(common.fields).map(([name, text]) => [`common_mcp_output.fields.${name}`, text] as const), authored.prose ?? 'en'),
  ]
}

// generated.json に resources があるプラグインは、resource ごとに summary を書く
function authoredResourceFindings(file: string, authored: AuthoredFile, generated: GeneratedFile): Finding[] {
  const written = authored.resources
  if (generated.resources === undefined) {
    return written === undefined ? [] : [{ file, field: 'resources', reason: 'is only for plugins with resources in generated.json (remove it)' }]
  }
  const expected = new Set(generated.resources.map(resource => resource.uri))
  const items = written ?? {}
  return [
    ...expected.keys().filter(uri => !Object.hasOwn(items, uri)).map(uri => ({ file, scope: uri, reason: 'resource is missing (present in generated.json)' })),
    ...Object.keys(items).filter(uri => !expected.has(uri)).map(uri => ({ file, scope: uri, reason: 'resource is not in generated.json (remove it)' })),
    ...Object.entries(items).filter(([uri]) => expected.has(uri)).flatMap(([uri, item]) => japaneseFindings(file, uri, [['summary', item.summary]], authored.prose ?? 'en')),
  ]
}

function entryFindings(file: string, id: string, entry: AuthoredEntry, generated: GeneratedEntry, names: Names, prose: NonNullable<Prose>): Finding[] {
  const texts: TextPair[] = [
    ...(entry.summary === undefined ? [] : [['summary', entry.summary] as const]),
    ...Object.entries(entry.arguments ?? {}).map(([name, text]) => [`arguments.${name}`, text] as const),
    ...(entry.output.format === 'json' ? Object.entries(entry.output.fields ?? {}).map(([name, text]) => [`output.fields.${name}`, text] as const) : []),
    ...entry.details.map((text, index) => [`details[${String(index)}]`, text] as const),
    ['stdin', entry.stdin],
    ...(entry.output.format === 'none' ? [] : [['output.description', entry.output.description] as const]),
    ...Object.entries(entry.mcp_output?.fields ?? {}).map(([name, text]) => [`mcp_output.fields.${name}`, text] as const),
    ['diagnostics', entry.diagnostics],
    ...entry.environment.map((item, index) => [`environment[${String(index)}].effect`, item.effect] as const),
    ...exitTexts(entry),
    ['on_error', entry.on_error],
    ...entry.effects.map((effect, index) => [`effects[${String(index)}].what`, effect.what] as const),
    ...entry.prerequisites.map((text, index) => [`prerequisites[${String(index)}]`, text] as const),
    ...entry.examples.map((example, index) => [`examples[${String(index)}].note`, example.note] as const),
    ...(entry.cli_reference?.examples ?? []).map((example, index) => [`cli_reference.examples[${String(index)}].note`, example.note] as const),
    ...Object.entries(entry.cli_reference?.options ?? {}).map(([name, text]) => [`cli_reference.options.${name}`, text] as const),
    ...Object.entries(entry.default_notes).map(([name, text]) => [`default_notes.${name}`, text] as const),
  ]
  return [
    ...japaneseFindings(file, id, texts.filter(([field, text]) => FIXED_VALUES[field] !== text), prose),
    ...helpFindings(file, id, entry, generated, prose),
    ...exampleFindings(file, id, entry, generated),
    ...cliOnlyFindings(file, id, entry, generated),
    ...cliOnlyInputFindings(file, id, entry, generated),
    ...namesFindings(file, id, entry, generated),
    ...annotationFindings(file, id, entry, generated),
    ...readOnlyFindings(file, id, entry, generated, names),
    ...mcpOutputFindings(file, id, entry, generated),
    ...behaviorFindings(file, entry.behaviors, id, id, 'behaviors'),
    ...environmentNameFindings(file, id, entry.environment),
  ]
}

function environmentFindings(file: string, scope: string | undefined, items: readonly { readonly name: string, readonly effect: string }[], prose: NonNullable<Prose>): Finding[] {
  return [
    ...environmentNameFindings(file, scope, items),
    ...japaneseFindings(file, scope, items.map((item, index) => [`environment[${String(index)}].effect`, item.effect] as const), prose),
  ]
}

function environmentNameFindings(file: string, scope: string | undefined, items: readonly { readonly name: string }[]): Finding[] {
  return items.entries().filter(([, item]) => !isValidEnvironmentName(item.name)).map(([index, item]) => ({
    file,
    ...(scope !== undefined && { scope }),
    field: `environment[${String(index)}].name`,
    reason: `${quote(item.name)} is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`,
  })).toArray()
}

function checkAuthored(file: string, name: string, mode: PluginInput['mode'], authored: AuthoredFile, generated: GeneratedFile | undefined): Finding[] {
  const findings: Finding[] = []
  if (authored.plugin !== name) {
    findings.push({ file, field: 'plugin', reason: `${quote(authored.plugin)} does not match the directory name ${quote(name)}` })
  }
  findings.push(...environmentFindings(file, undefined, authored.environment, authored.prose ?? 'en'))
  if (generated === undefined) return findings
  findings.push(
    ...behaviorFindings(file, authored.common_behaviors, undefined, `${generated.prefix}-COMMON`, 'common_behaviors'),
    ...commonMcpOutputFindings(file, authored, generated),
    ...authoredResourceFindings(file, authored, generated),
  )
  const byId = new Map(generated.entries.map(entry => [entry.id, entry]))
  // partial は generated.json にあって authored.yaml に無い項目を許す。
  const required = mode === 'complete' ? byId.keys().toArray() : []
  for (const id of required) {
    if (!Object.hasOwn(authored.entries, id)) findings.push({ file, scope: id, reason: 'entry is missing (present in generated.json)' })
  }
  for (const [id, entry] of Object.entries(authored.entries)) {
    const counterpart = byId.get(id)
    if (counterpart === undefined) findings.push({ file, scope: id, reason: 'entry is not in generated.json (remove it)' })
    else findings.push(...entryFindings(file, id, entry, counterpart, generated.names, authored.prose ?? 'en'))
  }
  return findings
}

function duplicateIds(files: readonly { readonly file: string, readonly ids: readonly string[] }[]): Finding[] {
  const first = new Map<string, string>()
  const findings: Finding[] = []
  for (const { file, ids } of files) {
    for (const id of ids) {
      const seenIn = first.get(id)
      if (seenIn === undefined) first.set(id, file)
      else findings.push({ file, scope: id, field: 'id', reason: seenIn === file ? 'is defined more than once' : `is also defined in ${seenIn}` })
    }
  }
  return findings
}

function behaviorIds(authored: AuthoredFile): string[] {
  return [...Object.values(authored.entries).flatMap(entry => entry.behaviors.map(item => item.id)), ...authored.common_behaviors.map(item => item.id)]
}

function validBehaviors(list: unknown): Behavior[] {
  return (Array.isArray(list) ? list : []).flatMap((item: unknown) => {
    const parsed = behaviorSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

// 形が崩れていても取れる振る舞いの項目の ID を集める。validate と links が同じ集め方を使う。
export function collectBehaviorIds(data: unknown): string[] {
  if (!isRecord(data)) return []
  const entries = isRecord(data['entries']) ? data['entries'] : {}
  return [
    ...Object.values(entries).flatMap(entry => (isRecord(entry) ? validBehaviors(entry['behaviors']) : []).map(item => item.id)),
    ...validBehaviors(data['common_behaviors']).map(item => item.id),
  ]
}

function validEnvironment(list: unknown): { readonly name: string, readonly effect: string }[] {
  const items: unknown[] = Array.isArray(list) ? list : []
  const result: { readonly name: string, readonly effect: string }[] = []
  for (const item of items) {
    if (isRecord(item) && typeof item['name'] === 'string' && typeof item['effect'] === 'string') result.push({ name: item['name'], effect: item['effect'] })
  }
  return result
}

// 形の確認が他の欄で落ちたときも、振る舞いの項目（言語・型・ID の収集）と environment の名前・言語は確認する。
// 1 回の実行で直す箇所をそろえて出し、プラグインをまたぐ ID の重なりも確かめるため。
function lenientFindings(file: string, data: unknown, generated: GeneratedFile | undefined): { readonly findings: Finding[], readonly ids: string[] } {
  if (!isRecord(data)) return { findings: [], ids: [] }
  const entries = isRecord(data['entries']) ? data['entries'] : {}
  const findings: Finding[] = []
  for (const [id, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue
    const behaviors = validBehaviors(entry['behaviors'])
    findings.push(
      ...behaviorFindings(file, behaviors, id, id, 'behaviors'),
      ...environmentFindings(file, id, validEnvironment(entry['environment']), proseOf(data)),
    )
  }
  const common = validBehaviors(data['common_behaviors'])
  if (generated !== undefined) {
    findings.push(...behaviorFindings(file, common, undefined, `${generated.prefix}-COMMON`, 'common_behaviors'))
  }
  findings.push(...environmentFindings(file, undefined, validEnvironment(data['environment']), proseOf(data)))
  return { findings, ids: collectBehaviorIds(data) }
}

function checkPlugin(plugin: PluginInput): { readonly findings: Finding[], readonly ids: readonly string[] } {
  const directory = `plugins/${plugin.name}/interface`
  if (!plugin.dirExists) {
    return { findings: [{ file: directory, reason: `directory is missing (listed in ${TARGETS_PATH})` }], ids: [] }
  }
  const generatedPath = `${directory}/generated.json`
  const authoredPath = `${directory}/authored.yaml`
  const findings = [...stateFindings(generatedPath, plugin.generated), ...stateFindings(authoredPath, plugin.authored)]
  let generated: GeneratedFile | undefined
  if (plugin.generated.kind === 'ok') {
    const parsed = parseWith(generatedFileSchema, generatedPath, plugin.generated.data, 'generated')
    findings.push(...parsed.findings)
    if (parsed.data !== undefined) {
      generated = parsed.data
      findings.push(...checkGenerated(generatedPath, plugin.name, parsed.data))
    }
  }
  if (plugin.authored.kind !== 'ok') return { findings, ids: [] }
  const parsed = parseWith(authoredFileSchema, authoredPath, plugin.authored.data, 'authored')
  const selected = isRecord(plugin.authored.data) && isRecord(plugin.authored.data['entries'])
    ? elementFindings(plugin.authored.data, authoredPath, plugin.authored.data['entries'])
    : []
  findings.push(...parsed.findings, ...selected)
  if (parsed.data === undefined || selected.length > 0) {
    const lenient = lenientFindings(authoredPath, plugin.authored.data, generated)
    findings.push(...lenient.findings)
    return { findings, ids: lenient.ids }
  }
  findings.push(...checkAuthored(authoredPath, plugin.name, plugin.mode, parsed.data, generated))
  if (plugin.mode === 'complete') {
    findings.push(...checkEnvironment({
      pluginDir: `plugins/${plugin.name}`,
      authoredPath,
      sources: plugin.sources,
      listed: [...parsed.data.environment, ...Object.values(parsed.data.entries).flatMap(entry => entry.environment)].map(item => item.name),
    }))
  }
  return { findings, ids: behaviorIds(parsed.data) }
}

// 定義書の形式を検証する。決定的に並べた Finding を返す。
export function validateDefinitions(plugins: readonly PluginInput[]): Finding[] {
  const checked = plugins.toSorted((left, right) => compareText(left.name, right.name)).map(plugin => ({
    plugin, ...checkPlugin(plugin),
  }))
  const files = checked.map(item => ({ file: `plugins/${item.plugin.name}/interface/authored.yaml`, ids: item.ids }))
  return sortFindings([...checked.flatMap(item => item.findings), ...duplicateIds(files)])
}
