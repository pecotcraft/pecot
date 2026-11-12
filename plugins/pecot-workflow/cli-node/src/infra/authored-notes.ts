/* eslint-disable security/detect-non-literal-fs-filename -- パスは pluginRoot() の下の固定の位置。引数 root はテストが一時ディレクトリを渡す */
// 定義書の手書きの側（interface/authored.yaml）から、コマンドの --help に出す 4 つの欄を読む。
// domain/yaml-document.ts は PyYAML 互換で `yes`・`no` を真偽値にするので、yaml の parse をそのまま使う。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parse } from 'yaml'
import { z } from 'zod'

import { pluginRoot } from '../version.js'

/**
引数の組み合わせの決まり。同時に使えない組か、あるオプションが他のオプションを要る関係
*/
export type Constraint
  = | { readonly conflicts: readonly string[] }
    | { readonly requires: Readonly<Record<string, readonly string[]>> }

export interface AuthoredNotes {
  readonly details: readonly string[]
  readonly constraints: readonly Constraint[]
  readonly examples: readonly Readonly<{ run: string, note: string }>[]
  /**
  入力名 → 初期値の補足の文
  */
  readonly defaultNotes: ReadonlyMap<string, string>
}

/**
読めたか、読めなかったか。読めなかったときは、読もうとした絶対パスと理由（1 行）を持つ
*/
export type NotesResult
  = | { readonly kind: 'read', readonly notes: AuthoredNotes }
    | { readonly kind: 'unreadable', readonly file: string, readonly reason: string }

const NAMES_SCHEMA = z.array(z.string())
const CONFLICTS_SCHEMA = z.object({ conflicts: NAMES_SCHEMA })
const DEPENDENCY_SCHEMA = z.object({ requires: z.record(z.string(), NAMES_SCHEMA) })
const CONSTRAINT_SCHEMA = z.union([CONFLICTS_SCHEMA, DEPENDENCY_SCHEMA])
const EXAMPLE_SCHEMA = z.object({ run: z.string(), note: z.string() })

const FILE_SCHEMA = z.object({ entries: z.record(z.string(), z.unknown()) })

const ENTRY_SCHEMA = z.object({
  details: NAMES_SCHEMA,
  constraints: z.array(CONSTRAINT_SCHEMA),
  examples: z.array(EXAMPLE_SCHEMA),
  default_notes: z.record(z.string(), z.string()),
})

/**
authored.yaml の置き場所。pluginRoot() の下の interface/
*/
function authoredFile(root: string = pluginRoot()): string {
  return path.join(root, 'interface', 'authored.yaml')
}

function unreadable(file: string, reason: string): NotesResult {
  return { kind: 'unreadable', file, reason }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
ID（`PW-CREATE-BRANCH`）の項目の details・constraints・examples・default_notes を読む。
ファイルが無い・YAML として読めない・項目が無い・欄の形が違うときは、場所と理由を持つ unreadable を返す
*/
export function readAuthoredNotes(id: string, root: string = pluginRoot()): NotesResult {
  const file = authoredFile(root)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  }
  catch (error: unknown) {
    return unreadable(file, isMissingFile(error) ? 'the file does not exist' : 'the file cannot be read')
  }
  let document: unknown
  try {
    // 警告は process.emitWarning で出るので、誤りだけ拾う（help の出力に yaml の警告を混ぜない）
    document = parse(text, { logLevel: 'error' })
  }
  catch {
    return unreadable(file, 'it is not valid YAML')
  }
  const parsedFile = FILE_SCHEMA.safeParse(document)
  if (!parsedFile.success) return unreadable(file, 'it has no entries')
  const entry = new Map(Object.entries(parsedFile.data.entries)).get(id)
  if (entry === undefined) return unreadable(file, `it has no entry ${id}`)
  const parsed = ENTRY_SCHEMA.safeParse(entry)
  if (!parsed.success) return unreadable(file, `the fields of ${id} have the wrong shape`)
  const { details, constraints, examples, default_notes: defaultNotes } = parsed.data
  return { kind: 'read', notes: { details, constraints, examples, defaultNotes: new Map(Object.entries(defaultNotes)) } }
}
