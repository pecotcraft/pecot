import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generatedFileSchema } from '../src/domain/schema.js'
import { validateRepository } from '../src/validate-repository.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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
  ['resources', []],
  ['resource-missing', [`error: ${PW}/authored.yaml: pecot-template://pr/default: resource is missing (present in generated.json)`]],
  ['resource-extra', [`error: ${PW}/authored.yaml: pecot-template://issue/old: resource is not in generated.json (remove it)`]],
  ['resources-unlisted', [`error: ${PW}/authored.yaml: resources: is only for plugins with resources in generated.json (remove it)`]],
  ['resource-duplicate', [`error: ${PW}/generated.json: pecot-template://issue/task: uri: is defined more than once`]],
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
  it.each(CASES)('見本のリポジトリ %s を検証すると、検証エラーの行を過不足なく決まった順で返す', async (name, expected) => {
    await explains(`リポジトリ全体の定義書を検証する \`validateRepository\` のテストです。見本のリポジトリ \`${name}\` を検証した場合に、期待する検証エラーの行だけを、決まった順で返すことを確認します。`)
    await step('fixture を検証し、指摘を比べる', async () => {
      expect(await validateRepository(await materialize(name))).toEqual(expected)
    })
  })

  it('空白だけの欄は、空の欄として検証エラーにする', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。`on_error` が空白だけの場合に、`is empty` の検証エラーが返ることを確認します。')
    const root = await materialize('valid')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original.replace('    on_error: Issues created before the failing file remain on GitHub.\n', '    on_error: "  "\n')
    expect(text).not.toBe(original)
    await step('定義書を書き換える', async () => {
      await writeFile(file, text)
    })
    await step('検証して結果を比べる', async () => {
      expect(await validateRepository(root)).toEqual([
        `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: is empty (write "default" if nothing remains)`,
      ])
    })
  })

  it('2 回続けて検証しても、同じ行を同じ順で返す', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。同じリポジトリを 2 回検証した場合に、検証エラーの行と順序が同じであることを確認します。')
    const root = await materialize('behavior-id')
    await step('検証を 2 回動かして比べる', async () => {
      expect(await validateRepository(root)).toEqual(await validateRepository(root))
    })
  })

  it('欄の欠けと statement の pattern の不一致が同時にあっても、両方を同じ実行で報告する', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。`on_error` の欠落と `statement` の `pattern` の不一致が同時にある場合、2 件の検証エラーを同じ実行で返すことを確認します。')
    const root = await materialize('valid')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original
      .replace('    on_error: Issues created before the failing file remain on GitHub.\n', '')
      .replace('もしフロントマターが不正なら、終了コード 1 で終わる', 'フロントマターが不正だと、終了コード 1 で終わる')
    await step('定義書を書き換える', async () => {
      await writeFile(file, text)
    })
    await step('検証して結果を比べる', async () => {
      expect(await validateRepository(root)).toEqual([
        `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`,
        `error: ${PW}/authored.yaml: PW-ISSUE-CREATE-01: statement does not match pattern "unwanted"`,
      ])
    })
  })

  it('別の欄の形が不正でも、environment の検証と behavior の id の重複を検出する', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。`on_error` が存在せず、環境変数名も不正な場合でも、`environment` の検証エラーと、別の plugin と重複する behavior の `id` のエラーが返ることを確認します。')
    const root = await materialize('behavior-id-reverse')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original
      .replace('    on_error: Issues created before the failing file remain on GitHub.\n', '')
      .replace('name: PECOT_GITHUB_API_URL', 'name: bad-name')
    await step('定義書を書き換える', async () => {
      await writeFile(file, text)
    })
    const lines = await step('リポジトリを検証する', () => validateRepository(root))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`error: ${PW}/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`)
      expect(lines.some(line => line.includes('environment[0].name') && line.includes('"bad-name"'))).toBe(true)
      expect(lines).toContain(`error: ${PW}/authored.yaml: PT-COMMON-01: id: is also defined in ${PT}/authored.yaml`)
    })
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

    it('fields のキーが最上位の properties（共通の 4 項目を除く）とそろっていると、検証エラーを返さない', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。`fields` のキーが、`mcp.output` の最上位のプロパティ（共通の 4 項目を除く）と同じ場合に、検証エラーが 0 件であることを確認します。')
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        lines: The listed keys.\n')
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([])
      })
    })

    it('fields のキーが最上位の properties と食い違うと、不足しているキーと余分なキーを報告する', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。`fields` のキーが `mcp.output` と食い違う場合に、不足しているキーと余分なキーを示す検証エラーが返ることを確認します。')
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        keys: The listed keys.\n        kind: The failure kind.\n')
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output.fields: has "keys", "kind" not in mcp.output (remove it)`,
          `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output.fields: is missing "lines" (present in mcp.output)`,
        ])
      })
    })

    it('MCP の面を持たない項目に mcp_output を書くと、削除を求める検証エラーにする', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。MCP の面を持たない項目に `mcp_output` がある場合に、削除を求める検証エラーが返ることを確認します。')
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        url: The issue URL.\n', 'PW-ISSUE-CREATE', { type: 'object', properties: COMMON, additionalProperties: false })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PW}/authored.yaml: PW-ISSUE-CREATE: mcp_output: is only for entries with an MCP surface (remove it)`,
        ])
      })
    })

    it('MCP の面を持つ項目が mcp_output を書いていないと、書くことを求める検証エラーにする', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。MCP の面を持つ項目に `mcp_output` がない場合に、書くことを求める検証エラーが返ることを確認します。')
      const root = await withMcpOutput('')
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: PT-AWS-S3-LS: mcp_output: is missing (write each tool field in mcp.output, or an empty fields when it returns none)`,
        ])
      })
    })

    const NOT_CLOSED = `error: ${PT}/generated.json: PT-AWS-S3-LS: mcp.output: is not a closed type (declare every field the tool returns and set additionalProperties to false)`

    it('mcp.output の最上位が閉じていない型だと、検証エラーにする', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。`mcp.output` の最上位に `additionalProperties: false` がない場合に、閉じた型にすることを求める検証エラーが返ることを確認します。')
      const root = await withMcpOutput('    mcp_output:\n      fields:\n        lines: The listed keys.\n', 'PT-AWS-S3-LS', { type: 'object', properties: { lines: { type: 'array' }, ...COMMON } })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([NOT_CLOSED])
      })
    })

    it('mcp.output の anyOf の枝だけが閉じていて最上位が閉じていないと、検証エラーにする', async () => {
      await explains('`mcp_output`（MCP ツールの出力の説明）の検証のテストです。`anyOf` の枝だけに `additionalProperties: false` があり、最上位にはない場合も、閉じていない型として検証エラーが返ることを確認します。')
      const root = await withMcpOutput(EMPTY_FIELDS, 'PT-AWS-S3-LS', { type: 'object', properties: COMMON, anyOf: [{ type: 'object', properties: { lines: { type: 'array' } }, additionalProperties: false }] })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([NOT_CLOSED])
      })
    })
  })

  describe('common_mcp_output', () => {
    const FIELDS = 'common_mcp_output:\n  fields:\n    kind: The failure kind.\n    detail: The failure text.\n    log: The raw output of the aws command.\n    warnings: The warning messages.\n'

    it('MCP の面を持つ項目がある plugin に common_mcp_output がないと、書くことを求める検証エラーにする', async () => {
      await explains('`common_mcp_output`（全ツールに共通の出力の説明）の検証のテストです。MCP の面を持つ項目がある plugin から `common_mcp_output` を削除した場合に、書くことを求める検証エラーが返ることを確認します。')
      const root = await withCommon(PT, text => text.replace(FIELDS, ''))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: common_mcp_output: is missing (write kind, detail, log and warnings in fields)`,
        ])
      })
    })

    it('common_mcp_output が共通の 4 項目と食い違うと、不足しているキーと余分なキーを報告する', async () => {
      await explains('`common_mcp_output`（全ツールに共通の出力の説明）の検証のテストです。`fields` に共通の 4 項目にないキーがあり、`log` が不足している場合に、それぞれの検証エラーが返ることを確認します。')
      const root = await withCommon(PT, text => text.replace('    log: The raw output of the aws command.\n', '    lines: The listed keys.\n'))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: common_mcp_output.fields: has "lines" that is not a common field (remove it)`,
          `error: ${PT}/authored.yaml: common_mcp_output.fields: is missing "log"`,
        ])
      })
    })

    it('common_mcp_output の説明の言語が prose と違うと、検証エラーにする', async () => {
      await explains('`common_mcp_output`（全ツールに共通の出力の説明）の検証のテストです。`prose` が英語の定義書で、説明が日本語の場合に、英語で書くことを求める検証エラーが返ることを確認します。')
      const root = await withCommon(PT, text => text.replace('The failure kind.', '失敗の種別です。'))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: common_mcp_output.fields.kind: contains Japanese text (write English)`,
        ])
      })
    })

    it('MCP の面を持つ項目がない plugin に common_mcp_output を書くと、削除を求める検証エラーにする', async () => {
      await explains('`common_mcp_output`（全ツールに共通の出力の説明）の検証のテストです。MCP の面を持つ項目がない plugin に `common_mcp_output` がある場合に、削除を求める検証エラーが返ることを確認します。')
      const root = await withCommon(PW, text => `${text}${FIELDS}`)
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PW}/authored.yaml: common_mcp_output: is only for plugins with an MCP surface (remove it)`,
        ])
      })
    })
  })

  describe('cli.only', () => {
    const DRY_RUN = { type: 'boolean', description: 'Print the plan and write nothing.' }
    const CLI = { positional: ['source', 'destination'], flags: { dry_run: ['--dry-run', '-n'] }, only: { dry_run: DRY_RUN } }
    const REFERENCE = '    cli_reference:\n      examples:\n        - run: pecot aws s3 cp s3://bucket/a ./a --dry-run\n          note: Print the plan.\n      options:\n        dry_run: Print the plan and write nothing.\n'

    // PT-AWS-S3-CP に CLI の面と cli を足し、authored.yaml を書き換える
    async function withCliOnly(cli: object = CLI, replace: (text: string) => string = text => text): Promise<string> {
      const root = await materialize('valid')
      const generatedFile = path.join(root, PT, 'generated.json')
      const generated = generatedFileSchema.parse(JSON.parse(await readFile(generatedFile, 'utf8')))
      const entries = generated.entries.map(item => item.id === 'PT-AWS-S3-CP'
        ? { ...item, surfaces: { ...item.surfaces, cli: { path: ['aws', 's3', 'cp'] } }, cli }
        : item)
      await writeFile(generatedFile, JSON.stringify({ ...generated, entries }))
      const file = path.join(root, PT, 'authored.yaml')
      const original = await readFile(file, 'utf8')
      await writeFile(file, replace(original))
      return root
    }

    const withReference = (text: string): string => text.replace('    default_notes: {}\n', () => `${REFERENCE}    default_notes: {}\n`)

    it('cli.flags の名前が cli.only にあり、cli_reference.options に説明があると、検証エラーを返さない', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli.flags` の名前が `cli.only` にあり、`cli_reference.options` に説明がある場合に、検証エラーが 0 件であることを確認します。')
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(await withCliOnly(CLI, withReference))).toEqual([])
      })
    })

    it('cli_reference を持たない項目は、cli_reference.options を求めない', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli_reference` を持たない項目の場合に、`cli_reference.options` がなくても検証エラーが返らないことを確認します。')
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(await withCliOnly())).toEqual([])
      })
    })

    it('cli.flags と cli.positional の名前が input と cli.only のどちらにも存在しないと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli.flags` と `cli.positional` に、`input` と `cli.only` のどちらにも存在しない名前を指定した場合、未知の入力名として検証エラーが返ることを確認します。')
      const root = await withCliOnly({ ...CLI, positional: ['source', 'target'], flags: { ...CLI.flags, force: ['--force'] } })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/generated.json: PT-AWS-S3-CP: cli.flags: unknown input name "force"`,
          `error: ${PT}/generated.json: PT-AWS-S3-CP: cli.positional: unknown input name "target"`,
        ])
      })
    })

    it('cli.only の名前が input にもある、または cli.flags にないと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli.only` の名前が `input` と重複する場合と、`cli.flags` にない場合、それぞれ検証エラーが返ることを確認します。')
      const root = await withCliOnly({ ...CLI, flags: { source: ['--source'] }, only: { source: { type: 'string' }, dry_run: DRY_RUN } })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/generated.json: PT-AWS-S3-CP: cli.only: "dry_run" is not in cli.flags (give the CLI-only input a flag)`,
          `error: ${PT}/generated.json: PT-AWS-S3-CP: cli.only: "source" is also in input (remove it from one; input is the MCP input)`,
        ])
      })
    })

    it('cli.only の説明が英語でないと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli.only` の `description` が日本語の場合に、英語で書くことを求める検証エラーが返ることを確認します。')
      const root = await withCliOnly({ ...CLI, only: { dry_run: { type: 'boolean', description: '予定だけを出します。' } } })
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/generated.json: PT-AWS-S3-CP: cli.only.dry_run.description: contains Japanese text (write English)`,
        ])
      })
    })

    it('cli.only の名前を MCP の使用例・arguments・mcp_output.fields に書くと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。CLI だけの入力 `dry_run` を、`arguments`・使用例の `arguments`・`mcp_output.fields` に書いた場合、削除を求める検証エラーがそれぞれ返ることを確認します。')
      const root = await withCliOnly(CLI, text => text
        .replace('          destination: ./a\n', '          destination: ./a\n          dry_run: true\n')
        .replace('  PT-AWS-S3-CP:\n', '  PT-AWS-S3-CP:\n    arguments:\n      dry_run: Print the plan.\n')
        .replace('    mcp_output:\n      fields: {}\n    diagnostics: default\n    environment: []\n    exit_status:\n      - kind: aws-error\n        when: The aws command exited with a non-zero status.\n    on_error: default\n    effects:\n      - target: aws\n        kind: destructive', '    mcp_output:\n      fields:\n        dry_run: The plan.\n    diagnostics: default\n    environment: []\n    exit_status:\n      - kind: aws-error\n        when: The aws command exited with a non-zero status.\n    on_error: default\n    effects:\n      - target: aws\n        kind: destructive'))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: arguments: "dry_run" is in cli.only (remove it; only the CLI takes it)`,
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: examples[0].arguments: "dry_run" is in cli.only (remove it; only the CLI takes it)`,
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: mcp_output.fields: "dry_run" is in cli.only (remove it; only the CLI takes it)`,
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: mcp_output.fields: has "dry_run" not in mcp.output (remove it)`,
        ])
      })
    })

    it('cli_reference を持つ項目で、cli.only の説明が options に不足しているか余分だと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`cli_reference.options` が `cli.only` の名前と食い違う場合に、不足している名前と余分な名前を示す検証エラーが返ることを確認します。')
      const root = await withCliOnly(CLI, text => withReference(text).replace('        dry_run: Print the plan and write nothing.\n', '        force: Overwrite.\n'))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: cli_reference.options: has "force" not in cli.only (remove it)`,
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: cli_reference.options: is missing "dry_run" (present in cli.only)`,
        ])
      })
    })

    it('cli_reference.options の説明の言語が prose と違うと、検証エラーにする', async () => {
      await explains('`cli.only`（CLI だけの入力）の検証のテストです。`prose` が英語の定義書で、`cli_reference.options` の説明が日本語の場合に、英語で書くことを求める検証エラーが返ることを確認します。')
      const root = await withCliOnly(CLI, text => withReference(text).replace('dry_run: Print the plan and write nothing.', 'dry_run: 予定だけを出します。'))
      await step('検証して結果を比べる', async () => {
        expect(await validateRepository(root)).toEqual([
          `error: ${PT}/authored.yaml: PT-AWS-S3-CP: cli_reference.options.dry_run: contains Japanese text (write English)`,
        ])
      })
    })
  })

  it('resource の summary の言語が prose と違うと、検証エラーにする', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。`prose` が英語の定義書で、resource の `summary` が日本語の場合に、英語で書くことを求める検証エラーが返ることを確認します。')
    const root = await materialize('resources')
    const file = path.join(root, PW, 'authored.yaml')
    const original = await readFile(file, 'utf8')
    const text = original.replace('summary: The body of a task issue.', 'summary: タスクの Issue の本文です。')
    expect(text).not.toBe(original)
    await step('定義書を書き換える', async () => {
      await writeFile(file, text)
    })
    await step('検証して結果を比べる', async () => {
      expect(await validateRepository(root)).toEqual([
        `error: ${PW}/authored.yaml: pecot-template://issue/task: summary: contains Japanese text (write English)`,
      ])
    })
  })

  it('targets.json が存在しないと、ファイルがないことを報告する', async () => {
    await explains('リポジトリ全体の定義書を検証する `validateRepository` のテストです。`libs/interface-spec/targets.json` が存在しないリポジトリを検証した場合に、`file is missing` の検証エラーを 1 行返すことを確認します。')
    await step('検証して結果を比べる', async () => {
      expect(await validateRepository(await materialize('empty'))).toEqual(['error: libs/interface-spec/targets.json: file is missing'])
    })
  })
})
