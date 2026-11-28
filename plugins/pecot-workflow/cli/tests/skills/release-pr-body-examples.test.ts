// w-release の docs PR を作る前に通す pr_check の例が、PR のテンプレート（create.md）の節と書式の規約を満たすことを確かめる。
// テンプレートの節が増減したとき、スキル側の例が置き去りになるのを止める。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { extractSectionsFromTemplate, validateBodyStyle, validateSections } from '@pecot/workflow-core/domain/sections.js'
import { templateFile } from '../../src/infra/template-store.js'
import { pluginRoot, readPluginFile, toolInputs } from './_helpers/documents.js'

// 本文の `<ver>` と `<package>` は、文書全体の記法の変数。実行時は実際の値に置き換わるので、検証の前に具体値へ替える
const DOC_PLACEHOLDERS: readonly (readonly [string, string])[] = [['<ver>', '1.2.3'], ['<package>', 'demo-pkg']]

interface PrCheckExample {
  /**
  body の前に書かれた入力名
  */
  readonly inputsBeforeBody: readonly string[]
  readonly body: string
}

function replacePlaceholders(text: string): string {
  let replaced = text
  for (const [from, to] of DOC_PLACEHOLDERS) replaced = replaced.split(from).join(to)
  return replaced
}

/**
`text` のブロックのうち、先頭行が pr_check のものから、入力名の並びと body の本文を取り出す
*/
function extractPrCheckExample(text: string): PrCheckExample | undefined {
  const match = /^```text\npr_check\n([\s\S]*?)^```$/mu.exec(text)
  const block = match?.[1]
  if (block === undefined) return undefined
  const lines = block.split('\n')
  const bodyAt = lines.indexOf('  body: |')
  if (bodyAt === -1) return undefined
  const inputsBeforeBody = lines.slice(0, bodyAt).flatMap(line => /^ {2}([a-z_]+):/u.exec(line)?.[1] ?? [])
  const body = lines.slice(bodyAt + 1).filter(line => line === '' || line.startsWith(' '.repeat(4))).map(line => line.slice(4)).join('\n').trimEnd()
  return { inputsBeforeBody, body: replacePlaceholders(body) }
}

describe.each(['release-single.md', 'release-multi.md'])('%s の docs PR の例', (name) => {
  const example = extractPrCheckExample(readPluginFile(`skills/w-release/references/${name}`))

  it('pr_check の例から、body を取り出せる', async () => {
    await explains(`w-release の \`${name}\` の docs PR の例のテストです。\`pr_check\` のブロックから \`body\` の本文を取り出せることを確認します。`)
    expect(example).toBeDefined()
  })

  it('body が create.md の必須の節と書式の規約を満たす', async () => {
    await explains(`\`${name}\` の例の \`body\` のテストです。PR のテンプレート \`create.md\` の必須の節がそろい、本文の書式の規約に違反していないことを確認します。`)
    const template = readPluginFile(path.relative(pluginRoot, templateFile('pr', 'create')))
    const sections = extractSectionsFromTemplate(template)
    expect(sections.length).toBeGreaterThan(0)
    expect(validateSections(example?.body ?? '', sections)).toEqual([])
    expect(validateBodyStyle(example?.body ?? '')).toEqual([])
  })

  it('screenshot で画像を入れない理由を渡し、body より前に置く', async () => {
    await explains(`\`${name}\` の例の入力の順序のテストです。画像を入れない理由を渡す \`screenshot\` が、\`body\` より前に指定されていることを確認します。`)
    expect(example?.inputsBeforeBody).toContain('screenshot')
  })

  it('pr_check の入力名が、ツールの入力に実在する', async () => {
    await explains(`\`${name}\` の例の入力名のテストです。例に書かれた入力名が、\`pr_check\` ツールの入力としてすべて存在することを確認します。`)
    const inputs = toolInputs().get('pr_check')
    const unknown = (example?.inputsBeforeBody ?? []).filter(input => inputs?.has(input) !== true)
    expect(unknown).toEqual([])
  })
})
