// 使う段階: 欄と POSIX の節の対応の表示（cli の field-map が JSON に書き、docs が表にする）と、その対応のテスト。
import { z } from 'zod'
import { compareText } from './utility.js'
import { authoredEntrySchema, generatedEntrySchema } from './schema.js'

export interface PosixRow {
  readonly section: string
  readonly fields: readonly string[]
  readonly writer: string
  readonly mcp: string
}

export interface BorrowedRow {
  readonly fields: readonly string[]
  readonly source: string
}

// contracts/definition-format.md「欄が従う枠組み」の 2 つの表。欄は schema.ts の項目の欄のパスで書く。
export const POSIX_MAP: readonly PosixRow[] = [
  { section: 'NAME', fields: ['id', 'name', 'description', 'summary', 'mcp.title'], writer: '書き出し。summary は人', mcp: 'Tool の name・title・description' },
  {
    section: 'SYNOPSIS',
    fields: ['constraints', 'surfaces.mcp.tool', 'surfaces.action.path'],
    writer: '書き出し。constraints は人',
    mcp: 'surfaces.mcp.tool',
  },
  { section: 'DESCRIPTION', fields: ['details'], writer: '人', mcp: '同じ' },
  {
    section: 'OPTIONS・OPERANDS',
    fields: ['input', 'arguments', 'default_notes'],
    writer: '書き出し。arguments・default_notes は人',
    mcp: 'Tool の inputSchema',
  },
  { section: 'STDIN', fields: ['stdin'], writer: '人', mcp: '常に none' },
  { section: 'INPUT FILES・OUTPUT FILES', fields: ['effects'], writer: '人', mcp: '同じ' },
  { section: 'ENVIRONMENT VARIABLES', fields: ['environment'], writer: '人。ソースの文字列と比べる', mcp: '同じ' },
  { section: 'ASYNCHRONOUS EVENTS', fields: [], writer: '欄にしない。全項目が既定の扱い', mcp: '—' },
  {
    section: 'STDOUT',
    fields: ['output', 'mcp.output', 'mcp_output.fields', 'action.outputs'],
    writer: 'output は人。MCP ツールの形と action の outputs は書き出し、ツールの項目の説明は人',
    mcp: 'Tool の outputSchema と結果の構造。output は常に format: none',
  },
  { section: 'STDERR', fields: ['diagnostics'], writer: '人', mcp: '常に default。失敗の文は exit_status、警告は details に書く' },
  { section: 'EXIT STATUS', fields: ['exit_status'], writer: '人', mcp: '失敗の種別' },
  { section: 'CONSEQUENCES OF ERRORS', fields: ['on_error'], writer: '人', mcp: '同じ' },
  { section: 'EXAMPLES', fields: ['examples'], writer: '人', mcp: 'tools/call の arguments' },
  { section: 'FUTURE DIRECTIONS', fields: ['deprecated'], writer: '書き出し', mcp: '同じ' },
  { section: 'CHANGE HISTORY', fields: [], writer: '欄にしない。各プラグインの CHANGELOG が担う', mcp: '—' },
]

export const BORROWED_MAP: readonly BorrowedRow[] = [
  { fields: ['effects', 'idempotent', 'mcp.annotations'], source: 'MCP の Tool の annotations（readOnlyHint・destructiveHint・idempotentHint・openWorldHint）。effects の kind は相手を問わず対応する。read は環境を変えない。write は足すだけで、destructive は上書き・削除を含む' },
  { fields: ['prerequisites'], source: '設計契約の事前条件。呼ぶ側が満たす' },
  { fields: ['behaviors'], source: '要件の書き方（EARS）と、要件とテストの双方向の追跡' },
  { fields: ['hidden'], source: 'このリポの決め。利用者の一覧に出さない項目を表す' },
]

// 中身を JSON Schema や注釈の 1 つの塊として扱う欄。下へたどらない。
const UNITS: ReadonlySet<string> = new Set(['input', 'mcp.output', 'mcp.annotations'])

function leafPaths(schema: z.ZodType, prefix: string): string[] {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema
  if (!(inner instanceof z.ZodObject) || UNITS.has(prefix)) return [prefix]
  const paths: string[] = []
  for (const [key, child] of Object.entries(inner.shape)) {
    if (child instanceof z.ZodType) paths.push(...leafPaths(child, prefix === '' ? key : `${prefix}.${key}`))
  }
  return paths
}

// 形式の定義（zod）が持つ項目の欄のパス。
export function definedFields(): string[] {
  return [...leafPaths(generatedEntrySchema, ''), ...leafPaths(authoredEntrySchema, '')].toSorted(compareText)
}

// 対応表に載っている欄のパス。
export function mappedFields(): string[] {
  return [...new Set([...POSIX_MAP.flatMap(row => row.fields), ...BORROWED_MAP.flatMap(row => row.fields)])].toSorted(compareText)
}
