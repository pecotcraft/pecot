// 定義書の exit_status[].kind を、実装が返しうる名前と比べる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { compareStrings } from '../src/domain/_shared/compare-strings.js'
import { CLI_ONLY_FAILURE_REASONS, FAILURE_KINDS, isFailureKind } from '../src/domain/_shared/failure-kind.js'

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../src')
const AUTHORED_PATH = path.resolve(import.meta.dirname, '../../interface/authored.yaml')
const ExitStatusSchema = z.object({ kind: z.string() })
const EntrySchema = z.object({ exit_status: z.array(ExitStatusSchema) })
const AuthoredSchema = z.object({ entries: z.record(z.string(), EntrySchema) })

const authored = AuthoredSchema.parse(parseYaml(readFileSync(AUTHORED_PATH, 'utf8')))
const entries = new Map(Object.entries(authored.entries))
function kindsOf(id: string): readonly string[] {
  const entry = entries.get(id)
  return entry === undefined ? [] : entry.exit_status.map(status => status.kind)
}

// 失敗の名前をリテラルで書いているファイルを、ツールごとに挙げる。テーマの名前は `theme-${reason}` で組むので、リテラルが無い分は読めない。
// `ignored` は、そのファイルに書かれていても、そのツールからは返らない名前。
const TOOL_SOURCES: readonly { readonly id: string, readonly files: readonly string[], readonly ignored: readonly string[] }[] = [
  { id: 'PV-DRAWIO-CREATE', files: ['commands/drawio/url.ts', 'commands/drawio/theme.ts', 'domain/slidev-theme/talk-theme.ts'], ignored: ['theme-root'] },
  { id: 'PV-DRAWIO-EXPORT', files: ['commands/drawio/export.ts'], ignored: ['invalid-option'] },
  { id: 'PV-EVIDENCE-CREATE', files: ['commands/evidence-xlsx/create.ts', 'infra/evidence-xlsx/workbook-writer.ts'], ignored: ['invalid-option'] },
  { id: 'PV-SLIDE-CREATE', files: ['commands/slidev-project/create.ts', 'infra/slidev-project/fs.ts'], ignored: [] },
  { id: 'PV-SLIDE-CONVERT', files: ['commands/slidev-to-pptx/convert.ts', 'commands/slidev-project/linked-theme.ts'], ignored: ['invalid-option'] },
  { id: 'PV-SLIDE-SYNC', files: ['commands/slidev-project/sync.ts', 'domain/slidev-project/sync.ts'], ignored: [] },
  { id: 'PV-SLIDE-LINT', files: ['commands/slidev-project/lint.ts', 'domain/slidev-project/lint.ts', 'infra/slidev-project/eslint-runner.ts'], ignored: ['invalid-option'] },
  { id: 'PV-SLIDE-DEV', files: ['mcp/tools/slide-dev.ts', 'mcp/dev-server-registry.ts'], ignored: ['cancelled'] },
  { id: 'PV-SLIDE-PAGE', files: ['mcp/tools/slide-page.ts'], ignored: [] },
  { id: 'PV-SLIDE-THEME', files: ['commands/slidev-project/theme.ts'], ignored: ['invalid-option'] },
  { id: 'PV-RUNTIME-SETUP', files: ['mcp/tools/setup.ts'], ignored: ['unknown'] },
]

describe('定義書の exit_status と FAILURE_KINDS', () => {
  it('exit_status[].kind の集合が FAILURE_KINDS と一致する', () => {
    const defined = Object.keys(authored.entries).flatMap(id => kindsOf(id))

    expect([...new Set(defined)].toSorted(compareStrings)).toEqual([...FAILURE_KINDS].toSorted(compareStrings))
  })

  it('CLI だけの名前は FAILURE_KINDS と重ならない', () => {
    expect(CLI_ONLY_FAILURE_REASONS.filter(reason => isFailureKind(reason))).toEqual([])
  })

  // parsePathArguments と failureKindOf は、setup 以外の全ツールの共有の処理にある。
  it.for(TOOL_SOURCES.filter(tool => tool.id !== 'PV-RUNTIME-SETUP'))('$id は、共有の処理が返す invalid-path と unknown を exit_status に持つ', (tool) => {
    expect(kindsOf(tool.id)).toEqual(expect.arrayContaining(['invalid-path', 'unknown']))
  })

  it.for(TOOL_SOURCES)('$id の実装に書かれた失敗の名前が、exit_status にある', (tool) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- TOOL_SOURCES の固定のパス
    const source = tool.files.map(file => readFileSync(path.join(SOURCE_ROOT, file), 'utf8')).join('\n')
    const written = FAILURE_KINDS.filter(kind => source.includes(`'${kind}'`) && !tool.ignored.includes(kind))

    expect(written.filter(kind => !kindsOf(tool.id).includes(kind))).toEqual([])
  })
})
