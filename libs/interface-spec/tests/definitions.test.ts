import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import type { PluginInput } from '../src/domain/validate.js'
import { loadJson, loadYaml } from '../src/infra/load.js'

const VALID = path.join(import.meta.dirname, 'fixtures', 'valid', 'plugins', 'pecot-workflow', 'interface')
const AUTHORED = 'plugins/pecot-workflow/interface/authored.yaml'
const GENERATED = 'plugins/pecot-workflow/interface/generated.json'

async function validPlugin(): Promise<PluginInput> {
  return {
    name: 'pecot-workflow',
    dirExists: true,
    mode: 'partial',
    generated: await loadJson(path.join(VALID, 'generated.json')),
    authored: await loadYaml(path.join(VALID, 'authored.yaml')),
    sources: [],
  }
}

function clone(value: unknown): unknown {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('record expected')
  return value
}

async function withGenerated(change: (data: Record<string, unknown>) => void): Promise<string[]> {
  const plugin = await validPlugin()
  if (plugin.generated.kind !== 'ok') throw new Error('fixture must load')
  const data = record(clone(plugin.generated.data))
  change(data)
  return validateDefinitions([{ ...plugin, generated: { kind: 'ok', data } }]).map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`)
}

async function withAuthored(change: (data: Record<string, unknown>) => void): Promise<string[]> {
  const plugin = await validPlugin()
  if (plugin.authored.kind !== 'ok') throw new Error('fixture must load')
  const data = record(clone(plugin.authored.data))
  change(data)
  return validateDefinitions([{ ...plugin, authored: { kind: 'ok', data } }]).map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`)
}

function entry(data: Record<string, unknown>, id: string): Record<string, unknown> {
  return record(record(data['entries'])[id])
}

function generatedEntry(data: Record<string, unknown>, index: number): Record<string, unknown> {
  const entries = data['entries']
  if (!Array.isArray(entries)) throw new TypeError('entries expected')
  return record(entries[index])
}

describe('generated.json checks', () => {
  it('plugin 名がディレクトリと違い、接頭辞も不正だと、止める', async () => {
    expect(await withGenerated((data) => {
      data['plugin'] = 'other'
      data['prefix'] = 'pw'
    })).toContain(`${GENERATED}||plugin|"other" does not match the directory name "pecot-workflow"`)
  })

  it('id に接頭辞が無い、id が重複する、surface の無い項目があると、止める', async () => {
    const lines = await withGenerated((data) => {
      const first = generatedEntry(data, 0)
      first['id'] = 'XX-ISSUE-CREATE'
      first['surfaces'] = {}
      generatedEntry(data, 1)['id'] = 'XX-ISSUE-CREATE'
    })
    expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|id|must start with "PW-" and use only A-Z, 0-9 and "-"`)
    expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|id|is defined more than once`)
    expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|surfaces|must have cli or mcp`)
  })

  it('接頭辞が小文字だと、止める', async () => {
    expect(await withGenerated((data) => {
      data['prefix'] = 'pw'
    })).toContain(`${GENERATED}||prefix|"pw" must be upper-case letters and digits`)
  })

  it('name・description・入力の説明に日本語があると、止める', async () => {
    const lines = await withGenerated((data) => {
      const first = generatedEntry(data, 0)
      first['description'] = '説明'
      record(record(first['input'])['properties'])['title'] = { type: 'string', description: '題名' }
    })
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|description|contains Japanese text (write English)`)
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|input.properties.title.description|contains Japanese text (write English)`)
  })

  it('input に無い cli 名があると、止める', async () => {
    const lines = await withGenerated((data) => {
      generatedEntry(data, 1)['cli'] = { positional: ['nope'], flags: { gone: ['--gone'] } }
    })
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-QUICK|cli.positional|unknown input name "nope"`)
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-QUICK|cli.flags|unknown input name "gone"`)
  })
})

describe('authored.yaml checks', () => {
  it('plugin 名がディレクトリと違うと、止める', async () => {
    expect(await withAuthored((data) => {
      data['plugin'] = 'other'
    })).toContain(`${AUTHORED}||plugin|"other" does not match the directory name "pecot-workflow"`)
  })

  it('環境変数名が不正、または effect に日本語があると、止める', async () => {
    const lines = await withAuthored((data) => {
      data['environment'] = [{ name: 'PECOT_*', effect: '効果' }, { name: 'ok name', effect: 'x' }]
    })
    expect(lines).toContain(`${AUTHORED}||environment[0].name|"PECOT_*" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
    expect(lines).toContain(`${AUTHORED}||environment[0].effect|contains Japanese text (write English)`)
    expect(lines).toContain(`${AUTHORED}||environment[1].name|"ok name" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
  })

  it('requires か default_notes が、input に無い名前を持つと止める', async () => {
    const lines = await withAuthored((data) => {
      const target = entry(data, 'PW-ISSUE-CREATE')
      target['constraints'] = [{ requires: { message: ['ttl'] } }]
      target['default_notes'] = { repo: 'x' }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0].requires|unknown input name "ttl"`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|default_notes|unknown input name "repo"`)
  })

  it('制約が conflicts でも requires でもないと、止める', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['constraints'] = [{ excludes: ['a'] }, 'text']
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0]|must be an object with "conflicts" or "requires"`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[1]|must be an object with "conflicts" or "requires"`)
  })

  it('exit_status が kind を持つと受け入れ、code と kind の両方が無いと止める', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['exit_status'] = [{ kind: 'auth-expired', when: 'Authentication expired.' }, { when: 'x' }, 7]
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[1].code|field is missing`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[2]|must be an object with "code" or "kind"`)
    expect(lines.some(line => line.includes('exit_status[0]'))).toBe(false)
  })

  it('behaviors が空、または behavior のフィールドが無いと、止める', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = []
      const create = entry(data, 'PW-ISSUE-CREATE')
      create['behaviors'] = [{ id: 'PW-ISSUE-CREATE-01', statement: '常に、終わる' }]
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors|must have at least 1 item(s)`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE-01|pattern|field is missing`)
  })

  it('behavior がオブジェクトでないと、その項目の名前を出す', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = ['x']
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors[0]|expected object but got string`)
  })

  it('共通の behavior に日本語が無いと、止める', async () => {
    const lines = await withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-01', pattern: 'event', statement: 'English only' }]
    })
    expect(lines).toEqual([`${AUTHORED}|PW-COMMON-01|statement|has no Japanese text (write Japanese)`])
  })

  it('共通の behavior に未知のパターンがあると、止める', async () => {
    const lines = await withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-02', pattern: 'nope', statement: '常に、終わる' }]
    })
    expect(lines).toEqual([`${AUTHORED}|PW-COMMON-02|pattern|unknown value "nope" (expected one of "ubiquitous", "event", "state", "unwanted", "optional")`])
  })

  it('entries がオブジェクトでない、または common_behaviors が無いと、ファイル単位で名前を出す', async () => {
    const lines = await withAuthored((data) => {
      data['entries'] = []
      delete data['common_behaviors']
    })
    expect(lines).toContain(`${AUTHORED}||entries|expected record but got array`)
    expect(lines).toContain(`${AUTHORED}||common_behaviors|field is missing (write [] if none)`)
  })

  it('output が無い、または schema の無い json の output だと、止める', async () => {
    const lines = await withAuthored((data) => {
      delete entry(data, 'PW-ISSUE-CREATE')['output']
      entry(data, 'PW-ISSUE-QUICK')['output'] = { format: 'json', description: 'x' }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|output|field is missing (write "format: none" if nothing is printed)`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|output.schema|field is missing`)
  })

  it('項目がオブジェクトでないと、報告する', async () => {
    const lines = await withAuthored((data) => {
      record(data['entries'])['PW-ISSUE-QUICK'] = 'x'
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|entry|expected object but got string`)
  })

  it('ファイルが無いと、報告する', async () => {
    const plugin = await validPlugin()
    const lines = validateDefinitions([{ ...plugin, generated: { kind: 'missing' }, authored: { kind: 'syntax', problems: [{ message: 'broken' }] } }])
    expect(lines).toEqual([
      { file: AUTHORED, reason: 'broken' },
      { file: GENERATED, reason: 'file is missing' },
    ])
  })
})

function japanize(data: Record<string, unknown>): Record<string, unknown> {
  const target = entry(data, 'PW-ISSUE-CREATE')
  target['details'] = ['結果を返す']
  target['stdin'] = 'none'
  target['output'] = { format: 'text', description: '標準出力に書く' }
  target['diagnostics'] = 'default'
  target['environment'] = [{ name: 'PECOT_X', effect: '挙動が変わる' }]
  target['exit_status'] = [{ code: 0, when: '成功したとき' }]
  target['on_error'] = 'default'
  target['effects'] = [{ target: 'github', kind: 'write', what: '作る' }]
  target['prerequisites'] = ['認証済み']
  target['examples'] = [{ run: 'pecot x', note: '例' }]
  target['default_notes'] = { title: '既定は空' }
  data['environment'] = [{ name: 'PECOT_Y', effect: '共通の挙動' }]
  return target
}

describe('prose（人が書く欄の言語）', () => {
  const TEXT_FIELDS = ['details[0]', 'output.description', 'exit_status[0].when', 'effects[0].what', 'prerequisites[0]', 'examples[0].note', 'default_notes.title']

  it('prose: ja で、決まった値以外の欄に日本語があれば、通る', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      japanize(data)
    })
    expect(lines.filter(line => line.includes('Japanese') && line.includes('|PW-ISSUE-CREATE|'))).toEqual([])
    expect(lines).not.toContain(`${AUTHORED}||environment[0].effect|has no Japanese text (write Japanese)`)
  })

  it('prose: ja で、日本語の無い欄は止める（決まった値の stdin・diagnostics・on_error は止めない）', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      const target = japanize(data)
      target['details'] = ['English']
      target['output'] = { format: 'text', description: 'English' }
      target['exit_status'] = [{ code: 0, when: 'English' }]
      target['effects'] = [{ target: 'github', kind: 'write', what: 'English' }]
      target['prerequisites'] = ['English']
      target['examples'] = [{ run: 'pecot x', note: 'English' }]
      target['default_notes'] = { title: 'English' }
      target['environment'] = [{ name: 'PECOT_X', effect: 'English' }]
      data['environment'] = [{ name: 'PECOT_Y', effect: 'English' }]
    })
    const reason = 'has no Japanese text (write Japanese)'
    for (const field of [...TEXT_FIELDS, 'environment[0].effect']) {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|${field}|${reason}`)
    }
    expect(lines).toContain(`${AUTHORED}||environment[0].effect|${reason}`)
    expect(lines.filter(line => line.endsWith(reason) && !line.includes('|PW-ISSUE-QUICK|'))).toHaveLength(TEXT_FIELDS.length + 2)
  })

  it('prose: ja で、stdin・diagnostics・on_error が決まった値以外の英語だと、止める', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      const target = japanize(data)
      target['stdin'] = 'JSON from stdin'
      target['diagnostics'] = 'warning lines'
      target['on_error'] = 'nothing changes'
    })
    for (const field of ['stdin', 'diagnostics', 'on_error']) {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|${field}|has no Japanese text (write Japanese)`)
    }
  })

  it('prose: ja でも、generated.json の欄は英語のまま', async () => {
    const plugin = await validPlugin()
    if (plugin.authored.kind !== 'ok' || plugin.generated.kind !== 'ok') throw new Error('fixture must load')
    const authored = record(clone(plugin.authored.data))
    authored['prose'] = 'ja'
    const generated = record(clone(plugin.generated.data))
    generatedEntry(generated, 0)['description'] = '日本語の説明'
    const lines = validateDefinitions([{ ...plugin, authored: { kind: 'ok', data: authored }, generated: { kind: 'ok', data: generated } }])
      .map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`)
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|description|contains Japanese text (write English)`)
  })

  it('prose: ja でも、behavior の statement は日本語を求める', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      data['common_behaviors'] = [{ id: 'PW-COMMON-01', pattern: 'event', statement: 'English only' }]
    })
    expect(lines).toContain(`${AUTHORED}|PW-COMMON-01|statement|has no Japanese text (write Japanese)`)
  })

  it('prose: en と、prose を省いたときは、日本語の欄を止める', async () => {
    for (const prose of [undefined, 'en']) {
      const lines = await withAuthored((data) => {
        if (prose !== undefined) data['prose'] = prose
        entry(data, 'PW-ISSUE-CREATE')['prerequisites'] = ['認証済み']
        entry(data, 'PW-ISSUE-CREATE')['stdin'] = 'none'
      })
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|prerequisites[0]|contains Japanese text (write English)`)
      expect(lines.filter(line => line.endsWith('(write English)'))).toHaveLength(1)
    }
  })

  it('prose: ja で CLI の面がある項目に help が無いと、止める', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      japanize(data)
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|help|is missing (--help reads it; write details, examples and default_notes in English)`)
  })

  it('prose: ja で help が英語で、examples の run と default_notes の名前がそろっていれば、通る', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      japanize(data)['help'] = { details: ['Returns the result'], examples: [{ run: 'pecot x', note: 'An example' }], default_notes: { title: 'Empty by default' } }
    })
    expect(lines.filter(line => line.includes('|PW-ISSUE-CREATE|help'))).toEqual([])
  })

  it('help に日本語があるか、examples の run か default_notes の名前が本体と違うと、止める', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      japanize(data)['help'] = { details: ['結果を返す'], examples: [{ run: 'pecot y', note: 'An example' }], default_notes: {} }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|help.details[0]|contains Japanese text (write English)`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|help.examples|must have the same run values, in the same order, as examples`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|help.default_notes|must have the same input names as default_notes`)
  })

  it('prose を省いた定義書に help があると、止める', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['help'] = { details: [], examples: [], default_notes: {} }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|help|is only for prose "ja" (remove it; --help reads details, examples and default_notes)`)
  })

  it('prose が ja・en 以外だと、止める', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'fr'
    })
    expect(lines.some(line => line.startsWith(`${AUTHORED}||prose|`))).toBe(true)
  })

  it('形が崩れた authored.yaml でも、prose: ja の environment の effect を確かめる', async () => {
    const lines = await withAuthored((data) => {
      data['prose'] = 'ja'
      data['environment'] = [{ name: 'PECOT_Y', effect: 'English' }]
      data['common_behaviors'] = 'broken'
    })
    expect(lines).toContain(`${AUTHORED}||environment[0].effect|has no Japanese text (write Japanese)`)
  })
})
