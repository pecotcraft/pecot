// 書き出しの見本が、書き出し済みの形式（generatedFileSchema）に合う。
// 見本は pecot-workflow の cli のテストが読む。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const samples = ['node-sample.json']
const directory = path.resolve(import.meta.dirname, '../../../plugins/pecot-workflow/cli/tests/interface-export')

describe('generatedFileSchema', () => {
  it.each(samples)('書き出しの見本 %s を generatedFileSchema で解析すると、成功する', async (name) => {
    await explains(`書き出しの見本が、書き出し済みの形式を表す \`generatedFileSchema\` に合うことのテストです。\`${name}\` を解析した場合に、成功することを確認します。`)
    const data: unknown = stepSync<unknown>('サンプルを読み込む', () => JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
    stepSync('スキーマで検証して比べる', () => {
      expect(generatedFileSchema.safeParse(data).success).toBe(true)
    })
  })
})
