import { describe, expect, it } from 'vitest'

import { frontmatterOutputs } from '../../tests/_helpers/python-output.js'
import type { FrontmatterResult } from '../../tests/_helpers/python-output.js'
import { FrontmatterError, parseCommentContent, parseFrontmatter, parsePullRequestContent } from '../frontmatter.js'

// 期待値は、Python の CLI の実出力（tests/python-output/frontmatter.json。record.py が Python で記録する）。
// フロントマターの YAML → 検証後の値、または FrontmatterError の文。
const OUTPUTS = frontmatterOutputs()

function issueContent(yamlText: string): string {
  return `---\n${yamlText}---\n\nbody\n`
}

function run(parse: (content: string) => { readonly frontmatter: object }, yamlText: string): FrontmatterResult {
  try {
    return { ok: { ...parse(issueContent(yamlText)).frontmatter } }
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return { error: error.message }
    throw error
  }
}

describe('Python の出力との一致', () => {
  it.each(OUTPUTS.keyAndTag)('issue キー・タグ %j', (yamlText, expected) => {
    expect(run(parseFrontmatter, yamlText)).toEqual(expected)
  })

  it.each(OUTPUTS.yamlFailures)('YAML の失敗 %j', (yamlText) => {
    const result = run(parseFrontmatter, yamlText)
    expect(result).toHaveProperty('error')
    expect(Object.values(result)[0]).toMatch(/^failed to parse YAML: /u)
  })

  it.each(OUTPUTS.issue)('issue %j', (yamlText, expected) => {
    expect(run(parseFrontmatter, yamlText)).toEqual(expected)
  })

  it.each(OUTPUTS.comment)('comment %j', (yamlText, expected) => {
    expect(run(parseCommentContent, yamlText)).toEqual(expected)
  })

  it.each(OUTPUTS.pullRequest)('pr %j', (yamlText, expected) => {
    expect(run(parsePullRequestContent, yamlText)).toEqual(expected)
  })
})
