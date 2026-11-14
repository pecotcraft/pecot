// generated.json の names（項目の名前の語彙）の検証。
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import type { FileState, PluginInput } from '../src/domain/validate.js'
import { validateRepository } from '../src/validate-repository.js'
import { loadJson, loadYaml } from '../src/infra/load.js'
import { materialize } from './helpers/repository.js'

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
  it('names が無いと、generated.json の形の誤りとして止める', async () => {
    const result = await withNames((data) => {
      Reflect.deleteProperty(data, 'names')
    })
    expect(result.some(line => line.startsWith(`${GENERATED}||names|`))).toBe(true)
  })

  it.for([
    { label: '区切りが空白と _ のどちらでもない', change: (names: Record<string, unknown>) => { names['separator'] = '-' } },
    { label: '語の位置が空', change: (names: Record<string, unknown>) => { names['positions'] = [] } },
    { label: '語に大文字がある', change: (names: Record<string, unknown>) => { names['positions'] = [[{ word: 'Issue', meaning: 'x' }]] } },
    { label: 'read_only が false', change: (names: Record<string, unknown>) => { names['positions'] = [[{ word: 'issue', meaning: 'x', read_only: false }]] } },
  ])('$label と、形の誤りとして止める', async ({ change }) => {
    const result = await withNames((data) => {
      change(record(data['names']))
    })
    expect(result.some(line => line.startsWith(`${GENERATED}||names`))).toBe(true)
  })

  it('同じ位置に同じ語が 2 回あると、止める', async () => {
    expect(await withNames((data) => {
      positions(data)[1]?.push({ word: 'create', meaning: 'again' })
    })).toContain(`${GENERATED}||names.positions[1]|"create" is listed more than once`)
  })
})

describe('項目の名前と names', () => {
  it('どの項目の名前も語彙に合うとき、何も出さない', async () => {
    expect(await withNames()).toEqual([])
  })

  it('語彙に無い語があると、語の位置と一緒に止める', async () => {
    expect(await withNames((data) => {
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue fast'
    })).toEqual([`${GENERATED}|PW-ISSUE-QUICK|name|word 2 "fast" is not in names.positions[1]`])
  })

  it('区切りが違う名前は、語の数の違いと語彙に無い語として止める', async () => {
    expect(await withNames((data) => {
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue_quick'
    })).toEqual([
      `${GENERATED}|PW-ISSUE-QUICK|name|"issue_quick" has 1 word(s) but names expects 2`,
      `${GENERATED}|PW-ISSUE-QUICK|name|word 1 "issue_quick" is not in names.positions[0]`,
    ])
  })

  it('rest が false で語が多いと、語の数の違いとして止める', async () => {
    expect(await withNames((data) => {
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue quick now'
    })).toEqual([`${GENERATED}|PW-ISSUE-QUICK|name|"issue quick now" has 3 word(s) but names expects 2`])
  })

  it('rest が true なら後ろの自由な語を許し、自由な語が無いと止める', async () => {
    const result = await withNames((data) => {
      const names = record(data['names'])
      names['rest'] = true
      entryNamed(data, 'PW-ISSUE-QUICK')['name'] = 'issue quick now'
    })
    expect(result).toEqual([`${GENERATED}|PW-ISSUE-CREATE|name|"issue create" has 2 word(s) but names expects 3 or more`])
  })

  it('rest の自由な語が英小文字と数字でないと、止める', async () => {
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

describe('読むだけの動詞と effects', () => {
  it('名前が read_only の語を持ち、write の effects もあると、authored.yaml の行で止める', async () => {
    expect(await withNames((data) => {
      verbIn(data, 'create')['read_only'] = true
    })).toEqual([`${AUTHORED}|PW-ISSUE-CREATE|effects[0]|has kind "write" but "create" is a read-only word in names`])
  })

  it('名前が read_only の語を持っても、effects が read だけなら通す', async () => {
    const plugin = await pluginOf('pecot-workflow', FIXTURE)
    if (plugin.authored.kind !== 'ok') throw new Error('fixture must load')
    const authored = okData(plugin.authored)
    record(record(authored['entries'])['PW-ISSUE-QUICK'])['effects'] = [{ target: 'git', kind: 'read', what: 'Reads the current branch.' }]
    const generated = okData(plugin.generated)
    verbIn(generated, 'quick')['read_only'] = true
    expect(validateDefinitions([{ ...plugin, generated: { kind: 'ok', data: generated }, authored: { kind: 'ok', data: authored } }])).toEqual([])
  })
})

describe('fixture の names', () => {
  it('合わない名前と読む動詞の書き込みを、validate が 1 件 1 行で出す', async () => {
    const root = await materialize('names')
    const result = await validateRepository(root)
    expect(result).toEqual([
      'error: plugins/pecot-tools/interface/generated.json: PT-AWS-S3-CP: name: "aws_s3" has 2 word(s) but names expects 3 or more',
      'error: plugins/pecot-tools/interface/generated.json: PT-AWS-S3-LS: name: word 2 "s4" is not in names.positions[1]',
      'error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: effects[0]: has kind "write" but "create" is a read-only word in names',
      'error: plugins/pecot-workflow/interface/generated.json: PW-ISSUE-QUICK: name: "issue_quick" has 1 word(s) but names expects 2',
      'error: plugins/pecot-workflow/interface/generated.json: PW-ISSUE-QUICK: name: word 1 "issue_quick" is not in names.positions[0]',
    ])
  })
})

describe('実物の定義書の names', () => {
  it.for([
    { plugin: 'pecot-visual', name: 'visual_create', id: 'PV-VISUAL-CREATE', expected: ['word 1 "visual" is not in names.positions[0]'] },
    { plugin: 'pecot-visual', name: 'setup', id: 'PV-SETUP', expected: ['"setup" has 1 word(s) but names expects 2', 'word 1 "setup" is not in names.positions[0]'] },
    { plugin: 'pecot-tools', name: 'aws_iam_list_roles', id: 'PT-AWS-IAM-LIST-ROLES', expected: ['word 2 "iam" is not in names.positions[1]'] },
  ])('$plugin に合わない名前 $name の項目を足すと、止める', async ({ plugin, name, id, expected }) => {
    const input = await pluginOf(plugin, path.join(PLUGINS, plugin, 'interface'))
    const data = okData(input.generated)
    const entries = list(data['entries'])
    entries.push({ ...record(entries[0]), id, name, surfaces: { mcp: { tool: name } } })
    expect(lines(input, data)).toEqual(expected.map(reason => `plugins/${plugin}/interface/generated.json|${id}|name|${reason}`))
  })

  it.for(['pecot-visual', 'pecot-tools'])('%s の定義書は、足す前は names に合う', async (plugin) => {
    const input = await pluginOf(plugin, path.join(PLUGINS, plugin, 'interface'))
    expect(lines(input, okData(input.generated))).toEqual([])
  })
})
