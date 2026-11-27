// generated.json の names（項目の名前の語彙）の検証。
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import type { FileState, PluginInput } from '../src/domain/validate.js'
import { validateRepository } from '../src/validate-repository.js'
import { loadJson, loadYaml } from '../src/infra/load.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'valid', 'plugins', 'pecot-workflow', 'interface')
const PLUGINS = path.join(import.meta.dirname, '..', '..', '..', 'plugins')
const GENERATED = 'plugins/pecot-workflow/interface/generated.json'
const AUTHORED = 'plugins/pecot-workflow/interface/authored.yaml'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('record expected')
  return value
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('array expected')
  return value
}

function okData(state: FileState): Record<string, unknown> {
  if (state.kind !== 'ok') throw new Error('fixture must load')
  return record(structuredClone(state.data))
}

async function pluginOf(name: string, directory: string): Promise<PluginInput> {
  return {
    name,
    root: `plugins/${name}`,
    dirExists: true,
    mode: 'partial',
    generated: await loadJson(path.join(directory, 'generated.json')),
    authored: await loadYaml(path.join(directory, 'authored.yaml')),
    sources: [],
  }
}

function lines(plugin: PluginInput, generated: Record<string, unknown>): string[] {
  return validateDefinitions([{ ...plugin, generated: { kind: 'ok', data: generated } }])
    .map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`)
}

async function withNames(change?: (data: Record<string, unknown>) => void): Promise<string[]> {
  const plugin = await pluginOf('pecot-workflow', FIXTURE)
  const data = okData(plugin.generated)
  change?.(data)
  return lines(plugin, data)
}

function entryNamed(data: Record<string, unknown>, id: string): Record<string, unknown> {
  const found = list(data['entries']).map(item => record(item)).find(item => item['id'] === id)
  if (found === undefined) throw new Error(`${id} is missing`)
  return found
}

function positions(data: Record<string, unknown>): unknown[][] {
  return list(record(data['names'])['positions']).map(item => list(item))
}

function verbIn(data: Record<string, unknown>, word: string): Record<string, unknown> {
  const found = (positions(data)[1] ?? []).map(item => record(item)).find(item => item['word'] === word)
  if (found === undefined) throw new Error(`${word} is missing`)
  return found
}

describe('names の形', () => {
  it('generated.json に names が存在しないと、names の形の誤りとして検証エラーにする', async () => {
    await explains('generated.json の `names`（項目の名前の語彙）を検証するテストです。`names` を削除した場合に、`names` に関する検証エラーが返ることを確認します。')
    const result = await step('定義書を書き換えて検証する', () => withNames((data) => {
      Reflect.deleteProperty(data, 'names')
    }))
    stepSync('結果を比べる', () => {
      expect(result.some(line => line.startsWith(`${GENERATED}||names|`))).toBe(true)
    })
  })

  it.for([
    { label: '区切りが空白と _ のどちらでもない', change: (names: Record<string, unknown>) => { names['separator'] = '-' } },
    { label: '語の位置が空', change: (names: Record<string, unknown>) => { names['positions'] = [] } },
    { label: '語に大文字がある', change: (names: Record<string, unknown>) => { names['positions'] = [[{ word: 'Issue', meaning: 'x' }]] } },
    { label: 'read_only が false', change: (names: Record<string, unknown>) => { names['positions'] = [[{ word: 'issue', meaning: 'x', read_only: false }]] } },
  ])('names が不正な形（$label）だと、検証エラーにする', async ({ label, change }) => {
    await explains(`generated.json の \`names\`（項目の名前の語彙）を検証するテストです。「${label}」の誤りを含む \`names\` を渡した場合に、\`names\` に関する検証エラーが返ることを確認します。`)
    const result = await step('定義書を書き換えて検証する', () => withNames((data) => {
      change(record(data['names']))
    }))
    stepSync('結果を比べる', () => {
      expect(result.some(line => line.startsWith(`${GENERATED}||names`))).toBe(true)
    })
  })

  it('names の同じ位置に同じ語が 2 回含まれていると、検証エラーにする', async () => {
    await explains('generated.json の `names`（項目の名前の語彙）を検証するテストです。動詞の位置に `create` を重複して含めた場合に、`is listed more than once` の検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        positions(data)[1]?.push({ word: 'create', meaning: 'again' })
      })).toContain(`${GENERATED}||names.positions[1]|"create" is listed more than once`)
    })
  })
})

describe('項目の名前と names', () => {
  it('すべての項目の名前が names の語彙に合っていると、検証エラーを返さない', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。すべての項目の名前が語彙に合っている場合に、検証エラーが 0 件であることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames()).toEqual([])
    })
  })

  it('項目の名前に names の語彙にない語があると、語の位置を含む検証エラーにする', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。`issue fast` のように語彙にない語を含む名前の場合に、何番目の語かを示す検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue fast'
      })).toEqual([`${GENERATED}|PW-ISSUE-QUICK|name|word 2 "fast" is not in names.positions[1]`])
    })
  })

  it('区切りが違う名前は、語の数の不一致と語彙にない語の 2 件で検証エラーにする', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。`issue_quick` のように区切りが `_` の名前の場合に、語の数が合わないことと語彙にない語があることの、2 件の検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue_quick'
      })).toEqual([
        `${GENERATED}|PW-ISSUE-QUICK|name|"issue_quick" has 1 word(s) but names expects 2`,
        `${GENERATED}|PW-ISSUE-QUICK|name|word 1 "issue_quick" is not in names.positions[0]`,
      ])
    })
  })

  it('位置の語が区切りでつないだ 2 語のとき、その 2 語を 1 つの位置に当て、長い語を先に当てる', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。対象の位置に `issue` と `issue dependency` の両方がある場合に、`issue dependency quick` は長い語に当たり、検証エラーになりません。`issue dependency` は動詞が無いので、語の数の検証エラーになることを確認します。')
    const result = await step('書き換えた定義書を検証する', () => withNames((data) => {
      positions(data)[0]?.push({ word: 'issue dependency', meaning: 'blocked by' })
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue dependency quick'
      entryNamed(data, 'PW-ISSUE-CREATE')['name'] = 'issue dependency'
    }))
    stepSync('指摘を比べる', () => {
      expect(result).toEqual([`${GENERATED}|PW-ISSUE-CREATE|name|"issue dependency" has 2 word(s) but names expects 3`])
    })
  })

  it('rest が false で語が多いと、語の数の不一致として検証エラーにする', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。`rest` が `false` の語彙に対して、`issue quick now` のように語が多い名前の場合に、語の数の不一致を示す検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue quick now'
      })).toEqual([`${GENERATED}|PW-ISSUE-QUICK|name|"issue quick now" has 3 word(s) but names expects 2`])
    })
  })

  it('rest が true だと、後ろの自由な語を許可し、自由な語がない名前は検証エラーにする', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。`rest` が `true` の場合に、`issue quick now` は検証エラーにならず、自由な語を持たない `issue create` は検証エラーになることを確認します。')
    const result = await step('定義書を書き換えて検証する', () => withNames((data) => {
      const names = record(data['names'])
      names['rest'] = true
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue quick now'
    }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual([`${GENERATED}|PW-ISSUE-CREATE|name|"issue create" has 2 word(s) but names expects 3 or more`])
    })
  })

  it('rest の自由な語が英小文字と数字でないと、検証エラーにする', async () => {
    await explains('項目の `name` と `names` の整合を検証するテストです。`rest` が `true` の場合に、自由な語が `Now` のように大文字を含む場合や空の場合に、英小文字と数字だけを求める検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        record(data['names'])['rest'] = true
        entryNamed(data, 'PW-ISSUE-CREATE')['name'] = 'issue create Now'
        entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue quick  x'
      })).toEqual([
        `${GENERATED}|PW-ISSUE-CREATE|name|word 3 "Now" must be lower-case letters and digits`,
        `${GENERATED}|PW-ISSUE-QUICK|name|word 3 "" must be lower-case letters and digits`,
      ])
    })
  })
})

describe('読むだけの動詞と effects', () => {
  it('read_only の語を含む名前の項目に write の effects があると、authored.yaml の検証エラーにする', async () => {
    await explains('名前の語彙の `read_only` と、定義書の `effects` の整合を検証するテストです。`create` を読み取り専用の語にした場合、`write` の `effects` を持つ項目で、`authored.yaml` の検証エラーが返ることを確認します。')
    await step('書き換えた定義書を検証し、指摘を比べる', async () => {
      expect(await withNames((data) => {
        verbIn(data, 'create')['read_only'] = true
      })).toEqual([`${AUTHORED}|PW-ISSUE-CREATE|effects[0]|has kind "write" but "create" is a read-only word in names`])
    })
  })

  it('名前が read_only の語を含んでいても、effects が read だけなら、検証エラーにしない', async () => {
    await explains('名前の語彙の `read_only` と、定義書の `effects` の整合を検証するテストです。名前に読み取り専用の語を含む項目でも、`effects` が `read` だけの場合に、検証エラーが 0 件であることを確認します。')
    const plugin = await pluginOf('pecot-workflow', FIXTURE)
    if (plugin.authored.kind !== 'ok') throw new Error('fixture must load')
    const authored = okData(plugin.authored)
    record(record(authored['entries'])['PW-ISSUE-QUICK'])['effects'] = [{ target: 'git', kind: 'read', what: 'Reads the current branch.' }]
    const generated = okData(plugin.generated)
    verbIn(generated, 'quick')['read_only'] = true
    stepSync('検証して結果を比べる', () => {
      expect(validateDefinitions([{ ...plugin, generated: { kind: 'ok', data: generated }, authored: { kind: 'ok', data: authored } }])).toEqual([])
    })
  })
})

describe('fixture の names', () => {
  it('名前が語彙に合わない項目と、読み取り専用の語で書き込む項目を、validate が 1 件ごとに 1 行で報告する', async () => {
    await explains('`interface-spec validate` が `names` の検証エラーを出力するテストです。名前の誤りが 4 件と、読み取り専用の語で書き込む項目が 1 件ある場合に、1 件ごとに 1 行で出力することを確認します。')
    const root = await materialize('names')
    const result = await step('リポジトリを検証する', () => validateRepository(root))
    stepSync('結果を比べる', () => {
      expect(result).toEqual([
        'error: plugins/pecot-tools/interface/generated.json: PT-AWS-S3-CP: name: "aws_s3" has 2 word(s) but names expects 3 or more',
        'error: plugins/pecot-tools/interface/generated.json: PT-AWS-S3-LS: name: word 2 "s4" is not in names.positions[1]',
        'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: effects[0]: has kind "write" but "create" is a read-only word in names',
        'error: plugins/pecot-workflow/interface/generated.json: PW-ISSUE-QUICK: name: "issue_quick" has 1 word(s) but names expects 2',
        'error: plugins/pecot-workflow/interface/generated.json: PW-ISSUE-QUICK: name: word 1 "issue_quick" is not in names.positions[0]',
      ])
    })
  })
})

describe('実物の定義書の names', () => {
  it.for([
    { plugin: 'pecot-visual', name: 'visual_create', id: 'PV-VISUAL-CREATE', expected: ['word 1 "visual" is not in names.positions[0]'] },
    { plugin: 'pecot-visual', name: 'setup', id: 'PV-SETUP', expected: ['"setup" has 1 word(s) but names expects 2', 'word 1 "setup" is not in names.positions[0]'] },
    { plugin: 'pecot-tools', name: 'aws_iam_list_roles', id: 'PT-AWS-IAM-LIST-ROLES', expected: ['word 2 "iam" is not in names.positions[1]'] },
  ])('$plugin の定義書へ、語彙に合わない名前 $name の項目を追加すると、検証エラーにする', async ({ plugin, name, id, expected }) => {
    await explains(`実際の定義書の \`names\` を検証するテストです。${plugin} の定義書に名前 \`${name}\` の項目を追加した場合に、語彙に合わない語を示す検証エラーが返ることを確認します。`)
    const input = await pluginOf(plugin, path.join(PLUGINS, plugin, 'interface'))
    const data = okData(input.generated)
    const entries = list(data['entries'])
    entries.push({ ...record(entries[0]), id, name, surfaces: { mcp: { tool: name } } })
    stepSync('検証して結果を比べる', () => {
      expect(lines(input, data)).toEqual(expected.map(reason => `plugins/${plugin}/interface/generated.json|${id}|name|${reason}`))
    })
  })

  it.for(['pecot-visual', 'pecot-tools'])('%s の定義書は、項目を追加する前は names の語彙に合っている', async (plugin) => {
    await explains(`実際の定義書の \`names\` を検証するテストです。${plugin} の定義書をそのまま検証した場合に、検証エラーが 0 件であることを確認します。`)
    const input = await pluginOf(plugin, path.join(PLUGINS, plugin, 'interface'))
    stepSync('検証して結果を比べる', () => {
      expect(lines(input, okData(input.generated))).toEqual([])
    })
  })
})
