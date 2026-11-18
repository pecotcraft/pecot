import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generatedFileSchema } from '../src/domain/schema.js'
import { validateRepository } from '../src/validate-repository.js'
import { materialize } from './helpers/repository.js'

const PW = 'plugins/pecot-workflow/interface'
const PT = 'plugins/pecot-tools/interface'

// 失敗の行の文字列は contracts/definition-format.md の「形式の検証が出す失敗」と同じ形。
const CASES: readonly (readonly [string, readonly string[]])[] = [
  ['valid', []],
  ['entry-missing', [`error: ${PW}/authored.yaml: PW-ISSUE-QUICK: entry is missing (present in generated.json)`]],
  ['entry-missing-partial', []],
  ['partial-empty', []],
  ['entry-extra-partial', [`error: ${PW}/authored.yaml: PW-ISSUE-OLD: entry is not in generated.json (remove it)`]],
  ['entry-extra', [`error: ${PW}/authored.yaml: PW-ISSUE-OLD: entry is not in generated.json (remove it)`]],
  ['field-missing', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`]],
  ['field-null', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: expected string but got null`]],
  ['field-empty', [
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: details[1]: is empty`,
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: is empty (write "default" if nothing remains)`,
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE-02: statement: is empty`,
  ]],
  ['unknown-field', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: owner: unknown field`]],
  ['constraint-name', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: constraints[0].conflicts: unknown input name "mesage"`]],
  ['language', [
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)`,
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)`,
  ]],
  ['pattern-mismatch', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE-01: statement does not match pattern "unwanted"`]],
  ['annotations', [`error: ${PT}/authored.yaml: PT-AWS-S3-CP: effects has kind "write" but annotations.readOnlyHint is true`]],
  ['behavior-id', [
    `error: ${PT}/authored.yaml: common_behaviors[0].id: "PW-COMMON-01" must be "PT-COMMON-NN" (NN is 2 digits)`,
    `error: ${PW}/authored.yaml: PW-COMMON-01: id: is also defined in ${PT}/authored.yaml`,
    `error: ${PW}/authored.yaml: PW-ISSUE-CREATE-01: id: is defined more than once`,
    `error: ${PW}/authored.yaml: PW-ISSUE-QUICK: behaviors[0].id: "PW-ISSUE-QUICK-1" must be "PW-ISSUE-QUICK-NN" (NN is 2 digits)`,
  ]],
  ['behavior-id-reverse', [
    `error: ${PW}/authored.yaml: common_behaviors[0].id: "PT-COMMON-01" must be "PW-COMMON-NN" (NN is 2 digits)`,
    `error: ${PW}/authored.yaml: PT-COMMON-01: id: is also defined in ${PT}/authored.yaml`,
  ]],
  ['format-unknown', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: output.format: unknown value "bogus" (expected one of "text", "json", "none")`]],
  ['file-format', [`error: ${PW}/authored.yaml: format: unknown value 2 (expected 1)`]],
  ['unknown-issue', [`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: exit_status[1].code: must be between 0 and 255`]],
  ['yaml-duplicate-key', [`error: ${PW}/authored.yaml:17: map keys must be unique`]],
  ['invalid-json', [`error: ${PW}/generated.json:1: is not valid JSON`]],
  ['interface-missing', [`error: ${PW}: directory is missing (listed in libs/interface-spec/targets.json)`]],
  ['targets-invalid', [
    'error: libs/interface-spec/targets.json: pecot-workflow: entries: unknown value "all" (expected one of "complete", "partial")',
    'error: libs/interface-spec/targets.json: pecot-workflow: coverage: field is missing',
    'error: libs/interface-spec/targets.json: pecot-workflow: extra: unknown field',
  ]],
]

// valid の fixture の authored.yaml を書き換える
async function withCommon(plugin: string, replace: (text: string) => string): Promise<string> {
  const root = await materialize('valid')
  const file = path.join(root, plugin, 'authored.yaml')
  await writeFile(file, replace(await readFile(file, 'utf8')))
  return root
}

describe('validateRepository', () => {
  it.each(CASES)('fixture %s を検証すると、失敗の行を過不足なく決まった順で返す', async (name, expected) => {
    expect(await validateRepository(await materialize(name))).toEqual(expected)
  })

  it('空白だけの欄も、空として止める', async () => {
    const root = await materialize('valid')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original.replace('    on_error: Issues created before the failing file remain on GitHub.\n', '    on_error: "  "\n')
    expect(text).not.toBe(original)
    await writeFile(file, text)
    expect(await validateRepository(root)).toEqual([
      `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: is empty (write "default" if nothing remains)`,
    ])
  })

  it('実行のたびに、同じ行を同じ順で返す', async () => {
    const root = await materialize('behavior-id')
    expect(await validateRepository(root)).toEqual(await validateRepository(root))
  })

  it('形のエラーとパターンの不一致を、同じ実行で報告する', async () => {
    const root = await materialize('valid')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original
      .replace('    on_error: Issues created before the failing file remain on GitHub.\n', '')
      .replace('もしフロントマターが不正なら、終了コード 1 で終わる', 'フロントマターが不正だと、終了コード 1 で終わる')
    await writeFile(file, text)
    expect(await validateRepository(root)).toEqual([
      `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`,
      `error: ${PW}/authored.yaml: PW-ISSUE-CREATE-01: statement does not match pattern "unwanted"`,
    ])
  })

  it('別のフィールドの形が合わなくても、environment を確かめ behavior の id を集める', async () => {
    const root = await materialize('behavior-id-reverse')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original
      .replace('    on_error: Issues created before the failing file remain on GitHub.\n', '')
      .replace('name: PECOT_GITHUB_API_URL', 'name: bad-name')
    await writeFile(file, text)
    const lines = await validateRepository(root)
    expect(lines).toContain(`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`)
    expect(lines.some(line => line.includes('environment[0].name') && line.includes('"bad-name"'))).toBe(true)
    expect(lines).toContain(`error: ${PW}/authored.yaml: PT-COMMON-01: id: is also defined in ${PT}/authored.yaml`)
  })

  describe('mcp_output', () => {
    const COMMON = { kind: { type: 'string' }, detail: { type: 'string' }, log: { type: 'string' }, warnings: { type: 'array' } }
    const LS_OUTPUT = {
      type: 'object',
      properties: { lines: { type: 'array' }, ...COMMON },
      additionalProperties: false,
      anyOf: [{ required: ['lines'] }, { required: ['kind', 'detail'] }],
    }

    const EMPTY_FIELDS = '    mcp_output:\n      fields: {}\n'

    // PT-AWS-S3-LS の mcp.output を差し替え、entry の mcp_output を書き換える。無い entry では diagnostics の前に足す
    async function withMcpOutput(mcpOutput: string, entry = 'PT-AWS-S3-LS', output: object = LS_OUTPUT): Promise<string> {
      const root = await materialize('valid')
      const generatedFile = path.join(root, PT, 'generated.json')
      const generated = generatedFileSchema.parse(JSON.parse(await readFile(generatedFile, 'utf8')))
      const entries = generated.entries.map(item => item.id === 'PT-AWS-S3-LS' && item.mcp?.output !== undefined
        ? { ...item, mcp: { ...item.mcp, output } }
        : item)
      expect(entries).not.toEqual(generated.entries)
      await writeFile(generatedFile, JSON.stringify({ ...generated, entries }))
      const file = path.join(root, entry.startsWith('PW-') ? PW : PT, 'authored.yaml')
      const original = await readFile(file, 'utf8')
      const start = original.indexOf(`  ${entry}:\n`)
      const at = original.indexOf('    diagnostics:', start)
      const head = original.slice(0, at)
      const kept = head.endsWith(EMPTY_FIELDS) ? head.slice(0, -EMPTY_FIELDS.length) : head
      await writeFile(file, `${kept}${mcpOutput}${original.slice(at)}`)
      return root
    }

    it('fields のキーが最上位の properties（共通の 4 項目を除く）とそろうと、何も報告しない', async () => {
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        lines: The listed keys.\n')
      expect(await validateRepository(root)).toEqual([])
    })

    it('fields のキーが最上位の properties と食い違うと、足りないキーと余るキーを報告する', async () => {
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        keys: The listed keys.\n        kind: The failure kind.\n')
      expect(await validateRepository(root)).toEqual([
        `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output.fields: has "keys", "kind" not in mcp.output (remove it)`,
        `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output.fields: is missing "lines" (present in mcp.output)`,
      ])
    })

    it('MCP の面を持たない項目に書くと、消すよう報告する', async () => {
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        url: The issue URL.\n', 'PW-ISSUE-CREATE', { type: 'object', properties: COMMON, additionalProperties: false })
      expect(await validateRepository(root)).toEqual([
        `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: mcp_output: is only for entries with an MCP surface (remove it)`,
      ])
    })

    it('MCP の面を持つ項目が mcp_output を書いていないと、書くよう報告する', async () => {
      const root = await withMcpOutput('')
      expect(await validateRepository(root)).toEqual([
        `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output: is missing (write each tool field in mcp.output, or an empty fields when it returns none)`,
      ])
    })

    const NOT_CLOSED = `error: ${PT}/generated.json: PT-AWS-S3-LS: mcp.output: is not a closed type (declare every field the tool returns and set additionalProperties to false)`

    it('最上位が閉じていない型の項目は、止める', async () => {
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        lines: The listed keys.\n', 'PT-AWS-S3-LS', { type: 'object', properties: { lines: { type: 'array' }, ...COMMON } })
      expect(await validateRepository(root)).toEqual([NOT_CLOSED])
    })

    it('anyOf の枝だけが閉じていて、最上位が閉じていない型の項目は、止める', async () => {
      const root = await withMcpOutput(EMPTY_FIELDS, 'PT-AWS-S3-LS', { type: 'object', properties: COMMON, anyOf: [{ type: 'object', properties: { lines: { type: 'array' } }, additionalProperties: false }] })
      expect(await validateRepository(root)).toEqual([NOT_CLOSED])
    })
  })

  describe('common_mcp_output', () => {
    const FIELDS = 'common_mcp_output:\n  fields:\n    kind: The failure kind.\n    detail: The failure text.\n    log: The raw output of the aws command.\n    warnings: The warning messages.\n'

    it('MCP の面を持つ項目があるプラグインで欠けていると、書くよう報告する', async () => {
      const root = await withCommon(PT, text => text.replace(FIELDS, ''))
      expect(await validateRepository(root)).toEqual([
        `error: ${PT}/authored.yaml: common_mcp_output: is missing (write kind, detail, log and warnings in fields)`,
      ])
    })

    it('共通の 4 項目と食い違うと、足りないキーと余るキーを報告する', async () => {
      const root = await withCommon(PT, text => text.replace('    log: The raw output of the aws command.\n', '    lines: The listed keys.\n'))
      expect(await validateRepository(root)).toEqual([
        `error: ${PT}/authored.yaml: common_mcp_output.fields: has "lines" that is not a common field (remove it)`,
        `error: ${PT}/authored.yaml: common_mcp_output.fields: is missing "log"`,
      ])
    })

    it('説明の言語が prose と違うと、報告する', async () => {
      const root = await withCommon(PT, text => text.replace('The failure kind.', '失敗の種別です。'))
      expect(await validateRepository(root)).toEqual([
        `error: ${PT}/authored.yaml: common_mcp_output.fields.kind: contains Japanese text (write English)`,
      ])
    })

    it('MCP の面を持つ項目が無いプラグインに書くと、消すよう報告する', async () => {
      const root = await withCommon(PW, text => `${text}${FIELDS}`)
      expect(await validateRepository(root)).toEqual([
        `error: ${PW}/authored.yaml: common_mcp_output: is only for plugins with an MCP surface (remove it)`,
      ])
    })
  })

  it('targets.json が無いと、報告する', async () => {
    expect(await validateRepository(await materialize('empty'))).toEqual(['error: libs/interface-spec/targets.json: file is missing'])
  })
})
