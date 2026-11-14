// 定義書の入力名の決まり。書き込む項目は dry_run を持つ。1 つの対象を指す入力名は 1 つだけにする
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { authoredFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'

const inputSchema = z.object({ properties: z.record(z.string(), z.unknown()) })
const entrySchema = z.object({ id: z.string(), input: inputSchema })
const generatedSchema = z.object({ entries: z.array(entrySchema) })

const directory = path.resolve(import.meta.dirname, '../../interface')
const authoredText = readFileSync(path.join(directory, 'authored.yaml'), 'utf8')
const authored = authoredFileSchema.parse(parseYaml(authoredText))
const generatedText = readFileSync(path.join(directory, 'generated.json'), 'utf8')
const generated = generatedSchema.parse(JSON.parse(generatedText))

const WRITING_KINDS: ReadonlySet<string> = new Set(['write', 'destructive'])
const OLD_NAMES: readonly string[] = ['issue', 'repo_ref', 'owner_repo', 'branch_name', 'plan']

function hasInput(id: string, name: string): boolean {
  return Object.keys(generated.entries.find(entry => entry.id === id)?.input.properties ?? {}).includes(name)
}

describe('定義書の入力名', () => {
  it('write か destructive の effects を持つ項目は、入力に dry_run を持つ', () => {
    const writing = Object.entries(authored.entries)
      .filter(([, entry]) => entry.effects.some(effect => WRITING_KINDS.has(effect.kind)))
      .map(([id]) => id)
    expect(writing.length).toBeGreaterThan(20)
    expect(writing.filter(id => !hasInput(id, 'dry_run'))).toEqual([])
  })

  it('対象ごとに使える入力名が 1 つだけで、改名前の名前を入力に持つ項目が無い', () => {
    const found = generated.entries.flatMap(entry => OLD_NAMES.filter(name => hasInput(entry.id, name)).map(name => `${entry.id}: ${name}`))
    expect(found).toEqual([])
  })
})
