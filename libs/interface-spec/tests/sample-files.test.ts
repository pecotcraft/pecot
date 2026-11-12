// 書き出しの見本が、書き出し済みの形式（generatedFileSchema）に合う。
// 見本は pecot-workflow の cli のテストが読む。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedFileSchema } from '../src/domain/schema.js'

const samples = ['node-sample.json']
const directory = path.resolve(import.meta.dirname, '../../../plugins/pecot-workflow/cli/tests/interface-export')

describe('generatedFileSchema', () => {
  it.each(samples)('%s を受け付ける', (name) => {
    const data: unknown = JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
    expect(generatedFileSchema.safeParse(data).success).toBe(true)
  })
})
