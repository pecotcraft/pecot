/* eslint-disable security/detect-non-literal-fs-filename -- パスは pluginRoot() の下の固定の位置。引数 root はテストが一時ディレクトリを渡す */
// 定義書の手書きの側（interface/authored.yaml）から、コマンドの --help に出す 3 つの欄（details・constraints・examples）を読む。
// 解析は yaml の parse をそのまま使う。domain/yaml-document.ts は PyYAML 互換で `yes`・`no` を真偽値にするので、ここでは使わない。
// libs/interface-spec は配布しないので import せず、必要な 3 つの欄の形だけを zod で確かめる。
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
}

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
})

/**
authored.yaml の置き場所。pluginRoot() の下の interface/
*/
function authoredFile(root: string = pluginRoot()): string {
  return path.join(root, 'interface', 'authored.yaml')
}

/**
ID（`PW-CREATE-BRANCH`）の項目の details・constraints・examples を返す。
ファイルが無い・YAML として読めない・項目が無い・欄の形が違うときは undefined
*/
export function readAuthoredNotes(id: string, root: string = pluginRoot()): AuthoredNotes | undefined {
  try {
    const text = readFileSync(authoredFile(root), 'utf8')
    const file = FILE_SCHEMA.parse(parse(text))
    return ENTRY_SCHEMA.parse(new Map(Object.entries(file.entries)).get(id))
  }
  catch {
    return undefined
  }
}
