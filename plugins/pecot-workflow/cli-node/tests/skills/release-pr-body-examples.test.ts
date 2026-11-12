// w-release の docs PR を作る pr_create の例が、PR のテンプレート（create.md）の節と書式の規約を満たすことを確かめる。
// テンプレートの節が増減したとき、スキル側の例が置き去りになるのを止める。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractSectionsFromTemplate, validateBodyStyle, validateSections } from '../../src/domain/sections.js'
import { templateFile } from '../../src/infra/template-store.js'
import { pluginRoot, readPluginFile, toolInputs } from './_helpers/documents.js'

// 本文の `<ver>` と `<package>` は、文書全体の記法の変数。実行時は実際の値に置き換わるので、検証の前に具体値へ替える
const DOC_PLACEHOLDERS: readonly (readonly [string, string])[] = [['<ver>', '1.2.3'], ['<package>', 'demo-pkg']]

interface PrCreateExample {
  /**
  message の前に書かれた入力名
  */
  readonly inputsBeforeMessage: readonly string[]
  readonly message: string
}

function replacePlaceholders(text: string): string {
  let replaced = text
  for (const [from, to] of DOC_PLACEHOLDERS) replaced = replaced.split(from).join(to)
  return replaced
}

/**
`text` のブロックのうち、先頭行が pr_create のものから、入力名の並びと message の本文を取り出す
*/
function extractPrCreateExample(text: string): PrCreateExample | undefined {
  const match = /^```text\npr_create\n([\s\S]*?)^```$/mu.exec(text)
  const block = match?.[1]
  if (block === undefined) return undefined
  const lines = block.split('\n')
  const messageAt = lines.indexOf('  message: |')
  if (messageAt === -1) return undefined
  const inputsBeforeMessage = lines.slice(0, messageAt).flatMap(line => /^ {2}([a-z_]+):/u.exec(line)?.[1] ?? [])
  const message = lines.slice(messageAt + 1).filter(line => line === '' || line.startsWith(' '.repeat(4))).map(line => line.slice(4)).join('\n').trimEnd()
  return { inputsBeforeMessage, message: replacePlaceholders(message) }
}

describe.each(['release-single.md', 'release-multi.md'])('%s の docs PR の例', (name) => {
  const example = extractPrCreateExample(readPluginFile(`skills/w-release/references/${name}`))

  it('pr_create の message が見つかる', () => {
    expect(example).toBeDefined()
  })

  it('message が create.md の必須の節と書式の規約を満たす', () => {
    const template = readPluginFile(path.relative(pluginRoot, templateFile('pr', 'create')))
    const sections = extractSectionsFromTemplate(template)
    expect(sections.length).toBeGreaterThan(0)
    expect(validateSections(example?.message ?? '', sections)).toEqual([])
    expect(validateBodyStyle(example?.message ?? '')).toEqual([])
  })

  it('画像を入れない理由を screenshot で、message より前に渡す', () => {
    expect(example?.inputsBeforeMessage).toContain('screenshot')
  })

  it('pr_create の入力名が、ツールの入力に実在する', () => {
    const inputs = toolInputs().get('pr_create')
    const unknown = (example?.inputsBeforeMessage ?? []).filter(input => inputs?.has(input) !== true)
    expect(unknown).toEqual([])
  })
})
