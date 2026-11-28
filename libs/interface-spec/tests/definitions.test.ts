import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import type { PluginInput } from '../src/domain/validate.js'
import { loadJson, loadYaml } from '../src/infra/load.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const VALID = path.join(import.meta.dirname, 'fixtures', 'valid', 'plugins', 'pecot-workflow', 'interface')
const AUTHORED = 'plugins/pecot-workflow/interface/authored.yaml'
const GENERATED = 'plugins/pecot-workflow/interface/generated.json'

async function validPlugin(): Promise<PluginInput> {
  return {
    name: 'pecot-workflow',
    root: 'plugins/pecot-workflow',
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
  it('generated.json の plugin 名がディレクトリ名と違い、接頭辞も不正だと、検証エラーにする', async () => {
    await explains('`generated.json` の検証のテストです。`plugin` がディレクトリ名と違い、`prefix` が小文字の場合に、`plugin` が一致しないという検証エラーが返ることを確認します。')
    await step('定義書を書き換えて検証し、指摘を比べる', async () => {
      expect(await withGenerated((data) => {
        data['plugin'] = 'other'
        data['prefix'] = 'pw'
      })).toContain(`${GENERATED}||plugin|"other" does not match the directory name "pecot-workflow"`)
    })
  })

  it('generated.json の id の接頭辞の欠落・id の重複・surface の欠落は、それぞれ検証エラーにする', async () => {
    await explains('`generated.json` の検証のテストです。`id` に接頭辞がない項目、`id` が重複する項目、`surfaces` が空の項目がある場合に、それぞれの検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withGenerated((data) => {
      const first = generatedEntry(data, 0)
      first['id'] = 'XX-ISSUE-CREATE'
      first['surfaces'] = {}
      generatedEntry(data, 1)['id'] = 'XX-ISSUE-CREATE'
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|id|must start with "PW-" and use only A-Z, 0-9 and "-"`)
      expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|id|is defined more than once`)
      expect(lines).toContain(`${GENERATED}|XX-ISSUE-CREATE|surfaces|must have mcp or action`)
    })
  })

  it('action の面だけを持つ項目は、surface の無い項目として止めない', async () => {
    await explains('`generated.json` の検証のテストです。action の面だけを持つ項目の場合に、`surfaces` の検証エラーを返さないことを確認します。')
    const lines = await step('action の面だけにして検証する', () => withGenerated((data) => {
      generatedEntry(data, 0)['surfaces'] = { action: { path: 'actions/issue-create' } }
    }))
    stepSync('surfaces の指摘が無いことを確かめる', () => {
      expect(lines.filter(line => line.includes('|surfaces|'))).toEqual([])
    })
  })

  it('root を持つ定義書の指摘は、root の下のパスで出す', async () => {
    await explains('定義書の検証のテストです。`root` を持つプラグインの場合に、検証エラーのファイルのパスを `root` の下のパスで返すことを確認します。')
    const plugin = await step('定義書を読む', () => validPlugin())
    const lines = stepSync('root を actions にして検証する', () =>
      validateDefinitions([{ ...plugin, root: 'actions', dirExists: false }]).map(finding => finding.file))
    stepSync('指摘のパスを比べる', () => {
      expect(lines).toEqual(['actions/interface'])
    })
  })

  it('generated.json の接頭辞が小文字だと、検証エラーにする', async () => {
    await explains('`generated.json` の検証のテストです。`prefix` が小文字の `pw` の場合に、大文字と数字だけを求める検証エラーが返ることを確認します。')
    await step('定義書を書き換えて検証し、指摘を比べる', async () => {
      expect(await withGenerated((data) => {
        data['prefix'] = 'pw'
      })).toContain(`${GENERATED}||prefix|"pw" must be upper-case letters and digits`)
    })
  })

  it('generated.json の description と入力の説明に日本語があると、検証エラーにする', async () => {
    await explains('`generated.json` の検証のテストです。項目の `description` と入力のプロパティの説明が日本語の場合に、英語で書くことを求める検証エラーがそれぞれ返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withGenerated((data) => {
      const first = generatedEntry(data, 0)
      first['description'] = '説明'
      record(record(first['input'])['properties'])['title'] = { type: 'string', description: '題名' }
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|description|contains Japanese text (write English)`)
      expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|input.properties.title.description|contains Japanese text (write English)`)
    })
  })
})

describe('authored.yaml checks', () => {
  it('authored.yaml の plugin 名がディレクトリ名と違うと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`plugin` がディレクトリ名と違う場合に、一致しないという検証エラーが返ることを確認します。')
    await step('定義書を書き換えて検証し、指摘を比べる', async () => {
      expect(await withAuthored((data) => {
        data['plugin'] = 'other'
      })).toContain(`${AUTHORED}||plugin|"other" does not match the directory name "pecot-workflow"`)
    })
  })

  it('authored.yaml の環境変数名が不正、または effect に日本語があると、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。環境変数名に使えない文字を含む場合と、`effect` が日本語の場合に、それぞれ検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['environment'] = [{ name: 'PECOT_*', effect: '効果' }, { name: 'ok name', effect: 'x' }]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}||environment[0].name|"PECOT_*" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
      expect(lines).toContain(`${AUTHORED}||environment[0].effect|contains Japanese text (write English)`)
      expect(lines).toContain(`${AUTHORED}||environment[1].name|"ok name" is not a valid name (use A-Z, 0-9 and "_"; "*" may appear once, with fixed characters on both sides)`)
    })
  })

  it('authored.yaml の requires か default_notes が input に存在しない名前を持つと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`requires` や `default_notes` に、`input` にない名前を指定した場合、未知の入力名として検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      const target = entry(data, 'PW-ISSUE-CREATE')
      target['constraints'] = [{ requires: { message: ['ttl'] } }]
      target['default_notes'] = { repo: 'x' }
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0].requires|unknown input name "ttl"`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|default_notes|unknown input name "repo"`)
    })
  })

  it('authored.yaml の constraints が conflicts でも requires でもないと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`constraints` の要素が `conflicts` と `requires` のどちらも持たない場合に、検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['constraints'] = [{ excludes: ['a'] }, 'text']
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[0]|must be an object with "conflicts" or "requires"`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|constraints[1]|must be an object with "conflicts" or "requires"`)
    })
  })

  it('authored.yaml の exit_status は、kind を持つ要素を受け入れ、kind がない要素を検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`kind` を持つ要素は検証エラーにならず、`code` だけの要素と、オブジェクトでない要素は検証エラーになることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['exit_status'] = [{ kind: 'auth-expired', when: 'Authentication expired.' }, { code: 1, when: 'x' }, 7]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[1].kind|field is missing`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|exit_status[2]|must be an object with "kind"`)
      expect(lines.some(line => line.includes('exit_status[0]'))).toBe(false)
    })
  })

  it('authored.yaml の behaviors が空、または behavior の必須の欄がないと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`behaviors` が空の場合と、`pattern` を持たない behavior がある場合に、それぞれ検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = []
      const create = entry(data, 'PW-ISSUE-CREATE')
      create['behaviors'] = [{ id: 'PW-ISSUE-CREATE-01', statement: '常に、終わる' }]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors|must have at least 1 item(s)`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE-01|pattern|field is missing`)
    })
  })

  it('authored.yaml の behavior がオブジェクトでないと、項目の ID を含む検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`behaviors` の要素が文字列の場合に、項目の ID と実際の型を含む検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      entry(data, 'PW-ISSUE-QUICK')['behaviors'] = ['x']
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|behaviors[0]|expected object but got string`)
    })
  })

  it('authored.yaml の共通の behavior の statement に日本語がないと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`common_behaviors` の `statement` が英語だけの場合に、日本語で書くことを求める検証エラーだけが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-01', pattern: 'event', statement: 'English only' }]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toEqual([`${AUTHORED}|PW-COMMON-01|statement|has no Japanese text (write Japanese)`])
    })
  })

  it('authored.yaml の共通の behavior の pattern が未知の値だと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`common_behaviors` の `pattern` に未定義の値を指定した場合、指定できる値を示す検証エラーだけが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['common_behaviors'] = [{ id: 'PW-COMMON-02', pattern: 'nope', statement: '常に、終わる' }]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toEqual([`${AUTHORED}|PW-COMMON-02|pattern|unknown value "nope" (expected one of "ubiquitous", "event", "state", "unwanted", "optional")`])
    })
  })

  it('authored.yaml の entries がオブジェクトでない、または common_behaviors が存在しないと、欄の名前を含む検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`entries` が配列の場合と、`common_behaviors` が存在しない場合に、それぞれ欄の名前を含む検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['entries'] = []
      delete data['common_behaviors']
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}||entries|expected record but got array`)
      expect(lines).toContain(`${AUTHORED}||common_behaviors|field is missing (write [] if none)`)
    })
  })

  it('authored.yaml の output が存在しない、または json の output に schema がないと、検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。`output` が存在しない項目と、`format: json` なのに `schema` がない項目について、それぞれ検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      delete entry(data, 'PW-ISSUE-CREATE')['output']
      entry(data, 'PW-ISSUE-QUICK')['output'] = { format: 'json', description: 'x' }
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|output|field is missing (write "format: none" if nothing is printed)`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|output.schema|field is missing`)
    })
  })

  it('authored.yaml の項目がオブジェクトでないと、項目の ID を含む検証エラーにする', async () => {
    await explains('`authored.yaml` の検証のテストです。項目が文字列の場合に、期待する型と実際の型を示す検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      record(data['entries'])['PW-ISSUE-QUICK'] = 'x'
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-QUICK|entry|expected object but got string`)
    })
  })

  it('generated.json が存在せず、authored.yaml が構文エラーだと、ファイルごとの検証エラーを返す', async () => {
    await explains('定義書のファイルの状態に応じた検証のテストです。`generated.json` が存在せず、`authored.yaml` が構文エラーの場合に、ファイルごとの検証エラーを返すことを確認します。')
    const plugin = await validPlugin()
    const lines = stepSync('定義書を書き換えて検証する', () => validateDefinitions([{ ...plugin, generated: { kind: 'missing' }, authored: { kind: 'syntax', problems: [{ message: 'broken' }] } }]))
    stepSync('指摘を比べる', () => {
      expect(lines).toEqual([
        { file: AUTHORED, reason: 'broken' },
        { file: GENERATED, reason: 'file is missing' },
      ])
    })
  })
})

function japanize(data: Record<string, unknown>): Record<string, unknown> {
  const target = entry(data, 'PW-ISSUE-CREATE')
  target['details'] = ['結果を返す']
  target['stdin'] = 'none'
  target['output'] = { format: 'text', description: '標準出力に書く' }
  target['diagnostics'] = 'default'
  target['environment'] = [{ name: 'PECOT_X', effect: '挙動が変わる' }]
  target['exit_status'] = [{ kind: 'ok', when: '成功したとき' }]
  target['on_error'] = 'default'
  target['effects'] = [{ target: 'github', kind: 'write', what: '作る' }]
  target['prerequisites'] = ['認証済み']
  target['examples'] = [{ arguments: {}, note: '例' }]
  target['default_notes'] = { title: '既定は空' }
  data['environment'] = [{ name: 'PECOT_Y', effect: '共通の挙動' }]
  return target
}

describe('prose（人が書く欄の言語）', () => {
  const TEXT_FIELDS = ['details[0]', 'output.description', 'exit_status[0].when', 'effects[0].what', 'prerequisites[0]', 'examples[0].note', 'default_notes.title']

  it('prose が ja で、日本語で書く欄がすべて日本語だと、検証エラーにしない', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose: ja` の定義書で、人が書く欄をすべて日本語にした場合、言語に関する検証エラーは返らないことを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'ja'
      japanize(data)
    }))
    stepSync('指摘を比べる', () => {
      expect(lines.filter(line => line.includes('Japanese') && line.includes('|PW-ISSUE-CREATE|'))).toEqual([])
      expect(lines).not.toContain(`${AUTHORED}||environment[0].effect|has no Japanese text (write Japanese)`)
    })
  })

  it('prose が ja で、日本語のない欄は検証エラーにし、決まった値の欄は検証エラーにしない', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose: ja` の定義書に英語の欄がある場合に、欄ごとの検証エラーが返り、`stdin` などの決まった値の欄は対象にならないことを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'ja'
      const target = japanize(data)
      target['details'] = ['English']
      target['output'] = { format: 'text', description: 'English' }
      target['exit_status'] = [{ kind: 'ok', when: 'English' }]
      target['effects'] = [{ target: 'github', kind: 'write', what: 'English' }]
      target['prerequisites'] = ['English']
      target['examples'] = [{ arguments: {}, note: 'English' }]
      target['default_notes'] = { title: 'English' }
      target['environment'] = [{ name: 'PECOT_X', effect: 'English' }]
      data['environment'] = [{ name: 'PECOT_Y', effect: 'English' }]
    }))
    const reason = 'has no Japanese text (write Japanese)'
    stepSync('指摘を比べる', () => {
      for (const field of [...TEXT_FIELDS, 'environment[0].effect']) {
        expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|${field}|${reason}`)
      }
      expect(lines).toContain(`${AUTHORED}||environment[0].effect|${reason}`)
      expect(lines.filter(line => line.endsWith(reason) && !line.includes('|PW-ISSUE-QUICK|'))).toHaveLength(TEXT_FIELDS.length + 2)
    })
  })

  it('prose が ja で、stdin・diagnostics・on_error が決まった値以外の英語だと、検証エラーにする', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`stdin`・`diagnostics`・`on_error` に、決まった値でない英語を書いた場合に、日本語で書くことを求める検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'ja'
      const target = japanize(data)
      target['stdin'] = 'JSON from stdin'
      target['diagnostics'] = 'warning lines'
      target['on_error'] = 'nothing changes'
    }))
    stepSync('指摘を比べる', () => {
      for (const field of ['stdin', 'diagnostics', 'on_error']) {
        expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|${field}|has no Japanese text (write Japanese)`)
      }
    })
  })

  it('prose が ja でも、generated.json の欄は英語で書くことを求める', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose: ja` の定義書で、`generated.json` の `description` が日本語の場合に、英語で書くことを求める検証エラーが返ることを確認します。')
    const plugin = await validPlugin()
    if (plugin.authored.kind !== 'ok' || plugin.generated.kind !== 'ok') throw new Error('fixture must load')
    const authored = record(clone(plugin.authored.data))
    authored['prose'] = 'ja'
    const generated = record(clone(plugin.generated.data))
    generatedEntry(generated, 0)['description'] = '日本語の説明'
    const lines = stepSync('定義書を書き換えて検証する', () => validateDefinitions([{ ...plugin, authored: { kind: 'ok', data: authored }, generated: { kind: 'ok', data: generated } }])
      .map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|description|contains Japanese text (write English)`)
    })
  })

  it('prose が ja のとき、behavior の statement は日本語で書くことを求める', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose: ja` で `statement` が英語の場合に、日本語で書くことを求める検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'ja'
      data['common_behaviors'] = [{ id: 'PW-COMMON-01', pattern: 'event', statement: 'English only' }]
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-COMMON-01|statement|has no Japanese text (write Japanese)`)
    })
  })

  it('prose が en のときと prose を省略したときは、日本語で書いた欄を検証エラーにする', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose` が `en` の場合と省略した場合に、日本語で書いた `prerequisites` だけが検証エラーになることを確認します。')
    await step('定義書を書き換えて検証し、指摘を比べる', async () => {
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
  })

  it('prose が ja と en 以外の値だと、検証エラーにする', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`prose` に `fr` を指定した場合に、`prose` に関する検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'fr'
    }))
    stepSync('指摘を比べる', () => {
      expect(lines.some(line => line.startsWith(`${AUTHORED}||prose|`))).toBe(true)
    })
  })

  it('authored.yaml の形が崩れていても、prose が ja のとき environment の effect の言語を検証する', async () => {
    await explains('`prose`（人が書く欄の言語）の検証のテストです。`common_behaviors` が不正な形でも、英語の `environment` の `effect` について、日本語で書くことを求める検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withAuthored((data) => {
      data['prose'] = 'ja'
      data['environment'] = [{ name: 'PECOT_Y', effect: 'English' }]
      data['common_behaviors'] = 'broken'
    }))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}||environment[0].effect|has no Japanese text (write Japanese)`)
    })
  })
})

async function withBoth(changeGenerated: (data: Record<string, unknown>) => void, changeAuthored: (data: Record<string, unknown>) => void): Promise<string[]> {
  const plugin = await validPlugin()
  if (plugin.generated.kind !== 'ok' || plugin.authored.kind !== 'ok') throw new Error('fixture must load')
  const generated = record(clone(plugin.generated.data))
  const authored = record(clone(plugin.authored.data))
  changeGenerated(generated)
  changeAuthored(authored)
  return validateDefinitions([{ ...plugin, generated: { kind: 'ok', data: generated }, authored: { kind: 'ok', data: authored } }])
    .map(finding => `${finding.file}|${finding.scope ?? ''}|${finding.field ?? ''}|${finding.reason}`)
}

// PW-ISSUE-CREATE を MCP の面の項目にする。
function withMcpSurface(title?: string): (data: Record<string, unknown>) => void {
  return (data) => {
    const target = generatedEntry(data, 0)
    target['surfaces'] = { mcp: { tool: 'issue_create' } }
    // annotations は、見本の PW-ISSUE-CREATE の effects（write・read）と idempotent（false）に合わせる
    const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    target['mcp'] = { ...(title !== undefined && { title }), output: { type: 'object', properties: {}, additionalProperties: false }, annotations }
  }
}

const TITLE = 'Create issues'

function mcpExamples(examples: unknown[]): (data: Record<string, unknown>) => void {
  return (data) => {
    const target = entry(data, 'PW-ISSUE-CREATE')
    target['output'] = { format: 'none' }
    target['mcp_output'] = { fields: {} }
    target['examples'] = examples
  }
}

describe('MCP の表示名と使用例', () => {
  it('MCP の面を持つ項目に mcp.title がないと、検証エラーにする', async () => {
    await explains('MCP の表示名と使用例の検証のテストです。MCP の面を持つ項目に `mcp.title` がない場合に、英語の表示名を付けることを求める検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withBoth(withMcpSurface(), mcpExamples([{ arguments: { title: 'x' }, note: 'An example' }])))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${GENERATED}|PW-ISSUE-CREATE|mcp.title|is missing (give the tool a display name in English)`)
    })
  })

  it('MCP の面を持つ項目の使用例が arguments の形で、キーが input にあれば、検証エラーにしない', async () => {
    await explains('MCP の表示名と使用例の検証のテストです。使用例が `arguments` の形で、`input` にあるキーだけを使っている場合に、検証エラーが 0 件であることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withBoth(withMcpSurface(TITLE), mcpExamples([{ arguments: { title: 'x', message: 'y' }, note: 'An example' }])))
    stepSync('指摘を比べる', () => {
      expect(lines.filter(line => line.includes('|PW-ISSUE-CREATE|'))).toEqual([])
    })
  })

  it('使用例の arguments が input に存在しない名前を持つか、必須の入力が欠けていると、検証エラーにする', async () => {
    await explains('MCP の表示名と使用例の検証のテストです。`arguments` に未知のキーがある場合と、必須の入力が欠けている場合、それぞれ検証エラーが返ることを確認します。')
    const lines = await step('定義書を書き換えて検証する', () => withBoth((data) => {
      withMcpSurface(TITLE)(data)
      record(generatedEntry(data, 0)['input'])['required'] = ['title']
    }, mcpExamples([{ arguments: { mesage: 'y' }, note: 'An example' }])))
    stepSync('指摘を比べる', () => {
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|examples[0].arguments|unknown input name "mesage"`)
      expect(lines).toContain(`${AUTHORED}|PW-ISSUE-CREATE|examples[0].arguments|is missing the required input "title"`)
    })
  })

  it('action の面だけを持つ項目の使用例は、with: の inputs を arguments の形で書けば検証エラーにしない', async () => {
    await explains('action の面だけを持つ項目の使用例の検証のテストです。`with:` の inputs を `arguments` の形で書いた場合に、使用例に関する検証エラーが返らないことを確認します。')
    const lines = await step('arguments の形の使用例で検証する', () => withAuthored((data) => {
      entry(data, 'PW-ISSUE-CREATE')['examples'] = [{ arguments: { title: 'x' }, note: 'An example' }]
    }))
    stepSync('使用例の指摘が無いことを確かめる', () => {
      expect(lines.filter(line => line.includes('|PW-ISSUE-CREATE|examples'))).toEqual([])
    })
  })
})
