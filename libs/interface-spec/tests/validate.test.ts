import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

describe('validateRepository', () => {
  it.each(CASES)('fixture %s のとき、期待する失敗の行を返す', async (name, expected) => {
    expect(await validateRepository(await materialize(name))).toEqual(expected)
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

  it('targets.json が無いと、報告する', async () => {
    expect(await validateRepository(await materialize('empty'))).toEqual(['error: libs/interface-spec/targets.json: file is missing'])
  })
})
