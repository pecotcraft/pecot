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
  it('rejects a plugin name that differs from the directory and a bad prefix', async () => {
    expect(await withGenerated((data) => {
      data['plugin'] = 'other'
      data['prefix'] = 'pw'
    })).toContain(`${GENERATED}||plugin|"other" does not match the directory name "pecot-workflow"`)
  })

  it('rejects an id without the prefix, a repeated id, and an entry without a surface', async () => {
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

  it('rejects a prefix in lower case', async () => {
    expect(await withGenerated((data) => {
      data['prefix'] = 'pw'
    })).toContain(`${GENERATED}||prefix|"pw" must be upper-case letters and digits`)
  })

  it('rejects Japanese in name, description and input descriptions', async () => {
    const lines = await withGenerated((data) => {
      const first = generatedEntry(data, 0)
      first['description'] = '説明'
      record(record(first['input'])['properties'])['title'] = { type: 'string', description: '題名' }
    })
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|description|contains Japanese text (write English)`)
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|input.properties.title.description|contains Japanese text (write English)`)
  })

  it('rejects cli names that are not in input', async () => {
    const lines = await withGenerated((data) => {
      generatedEntry(data, 1)['cli'] = { positional: ['nope'], flags: { gone: ['--gone'] } }
    })
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-QUICK|cli.positional|unknown input name "nope"`)
    expect(lines).toContain(`${GENERATED}|PW-ISSUE-QUICK|cli.flags|unknown input name "gone"`)
  })
})

describe('authored.yaml checks', () => {
  it('rejects a plugin name that differs from the directory', async () => {
    expect(await withAuthored((data) => {
      data['plugin'] = 'other'
    })).toContain(`${AUTHORED}||plugin|"other" does not match the directory name "pecot-workflow"`)
  })

  it('rejects bad environment names and Japanese in their effect', async () => {
    const lines = await withAuthored((data) => {
      data['environment'] = [{ name: 'PECOT_*', effect: '効果' }, { name: 'ok name', effect: 'x' }]
    })
    expect(lines).toContain(`${AUTHORED}||environment[0].name|"PECOT_*" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
    expect(lines).toContain(`${AUTHORED}||environment[0].effect|contains Japanese text (write English)`)
    expect(lines).toContain(`${AUTHORED}||environment[1].name|"ok name" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
  })

  it('rejects names in requires and default_notes that are not in input', async () => {
    const lines = await withAuthored((data) => {
      const target = entry(data, 'PW-ISSUE-CREATE')
      target['constraints'] = [{ requires: { message: ['ttl'] } }]
      target['default_notes'] = { repo: 'x' }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0].requires|unknown input name "ttl"`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|default_notes|unknown input name "repo"`)
  })

  it('rejects a constraint that is neither conflicts nor requires', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['constraints'] = [{ excludes: ['a'] }, 'text']
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0]|must be an object with "conflicts" or "requires"`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[1]|must be an object with "conflicts" or "requires"`)
  })

  it('accepts an exit_status with kind and rejects one with neither code nor kind', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['exit_status'] = [{ kind: 'auth-expired', when: 'Authentication expired.' }, { when: 'x' }, 7]
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[1].code|field is missing`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[2]|must be an object with "code" or "kind"`)
    expect(lines.some(line => line.includes('exit_status[0]'))).toBe(false)
  })

  it('rejects an empty behaviors list and a missing behavior field', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = []
      const create = entry(data, 'PW-ISSUE-CREATE')
      create['behaviors'] = [{ id: 'PW-ISSUE-CREATE-01', statement: '常に、終わる' }]
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors|must have at least 1 item(s)`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE-01|pattern|field is missing`)
  })

  it('names the entry for a behavior that is not an object', async () => {
    const lines = await withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = ['x']
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors[0]|expected object but got string`)
  })

  it('rejects a common behavior with no Japanese', async () => {
    const lines = await withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-01', pattern: 'event', statement: 'English only' }]
    })
    expect(lines).toEqual([`${AUTHORED}|PW-COMMON-01|statement|has no Japanese text (write Japanese)`])
  })

  it('rejects a common behavior with an unknown pattern', async () => {
    const lines = await withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-02', pattern: 'nope', statement: '常に、終わる' }]
    })
    expect(lines).toEqual([`${AUTHORED}|PW-COMMON-02|pattern|unknown value "nope" (expected one of "ubiquitous", "event", "state", "unwanted", "optional")`])
  })

  it('names the file level for a non-object entries and a missing common_behaviors', async () => {
    const lines = await withAuthored((data) => {
      data['entries'] = []
      delete data['common_behaviors']
    })
    expect(lines).toContain(`${AUTHORED}||entries|expected record but got array`)
    expect(lines).toContain(`${AUTHORED}||common_behaviors|field is missing (write [] if none)`)
  })

  it('rejects a missing output and a json output without schema', async () => {
    const lines = await withAuthored((data) => {
      delete entry(data, 'PW-ISSUE-CREATE')['output']
      entry(data, 'PW-ISSUE-QUICK')['output'] = { format: 'json', description: 'x' }
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|output|field is missing (write "format: none" if nothing is printed)`)
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|output.schema|field is missing`)
  })

  it('reports an entry that is not an object', async () => {
    const lines = await withAuthored((data) => {
      record(data['entries'])['PW-ISSUE-QUICK'] = 'x'
    })
    expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|entry|expected object but got string`)
  })

  it('reports missing files', async () => {
    const plugin = await validPlugin()
    const lines = validateDefinitions([{ ...plugin, generated: { kind: 'missing' }, authored: { kind: 'syntax', problems: [{ message: 'broken' }] } }])
    expect(lines).toEqual([
      { file: AUTHORED, reason: 'broken' },
      { file: GENERATED, reason: 'file is missing' },
    ])
  })
})
