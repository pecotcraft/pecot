import { describe, expect, it } from 'vitest'

import { frontmatterOutputs } from '../../../tests/_helpers/python-output.js'
import type { FrontmatterResult } from '../../../tests/_helpers/python-output.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { FrontmatterError, parseFrontmatter } from '../frontmatter.js'

// 期待値は、Python の CLI の実出力（tests/python-output/frontmatter.json。作り直さない記録）。
// フロントマターの YAML → 検証後の値、または FrontmatterError の文。
const OUTPUTS = frontmatterOutputs()

// #378 で意図して変えた入力。status と order を省けるようにし、blocked_by を足した
const CHANGED_ISSUE_OUTPUTS: ReadonlyMap<string, FrontmatterResult> = new Map([
  ['title: T\ntype: task\nrepository: o/r\nstatus: ready\nparent_epic: 3\n', { ok: { title: 'T', type: 'task', repository: 'o/r', status: 'ready', labels: [], parent_epic: 3 } }],
  ['title: T\ntype: task\nrepository: o/r\nstatus: ready\nparent_epic: false\n', { ok: { title: 'T', type: 'task', repository: 'o/r', status: 'ready', labels: [], parent_epic: 0 } }],
  ['title: T\n', { error: 'validation error:\n  - type: Field required\n  - repository: Field required' }],
])

function issueContent(yamlText: string): string {
  return `---\n${yamlText}---\n\nbody\n`
}

function run(parse: (content: string) => { readonly frontmatter: object }, yamlText: string): FrontmatterResult {
  try {
    // blocked_by の空の一覧は #378 で足した既定の値なので、Python の記録との比較から外す
    const parsed: Record<string, unknown> = { ...parse(issueContent(yamlText)).frontmatter }
    const { blocked_by: blockedBy, ...rest } = parsed
    return { ok: Array.isArray(blockedBy) && blockedBy.length === 0 ? rest : parsed }
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return { error: error.message }
    throw error
  }
}

describe('Python の出力との一致', () => {
  it.each(OUTPUTS.keyAndTag)('issue のキーとタグが %j のとき、Python の出力と一致する', async (yamlText, expected) => {
    await explains('フロントマターを検証する関数が、Python の CLI の記録と同じ結果を返すことのテストです。issue のキーとタグを含むフロントマターを渡した場合に、検証後の値か、エラーの文が記録と同じになることを確認します。')
    expect(run(parseFrontmatter, yamlText)).toEqual(expected)
  })

  it.each(OUTPUTS.yamlFailures)('YAML が %j で失敗するとき、failed to parse YAML のエラーを返す', async (yamlText) => {
    await explains('フロントマターを検証する関数が、Python の CLI の記録と同じ結果を返すことのテストです。YAML として読めないフロントマターを渡した場合に、`failed to parse YAML: ` で始まるエラーの文を返すことを確認します。')
    const result = run(parseFrontmatter, yamlText)
    expect(result).toHaveProperty('error')
    expect(Object.values(result)[0]).toMatch(/^failed to parse YAML: /u)
  })

  it.each(OUTPUTS.issue)('issue のフロントマターが %j のとき、Python の出力と一致する（意図して変えた入力を除く）', async (yamlText, recorded) => {
    await explains('フロントマターを検証する関数が、Python の CLI の記録と同じ結果を返すことのテストです。issue のフロントマターを渡した場合に、検証後の値かエラーの文が記録と同じになり、#378 で意図して変えた入力だけは変更後の期待値と同じになることを確認します。')
    expect(run(parseFrontmatter, yamlText)).toEqual(CHANGED_ISSUE_OUTPUTS.get(yamlText) ?? recorded)
  })
})
