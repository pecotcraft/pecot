import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import { loadJson, loadYaml } from '../src/infra/load.js'
import { step } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const VALID = path.join(import.meta.dirname, 'fixtures', 'valid', 'plugins', 'pecot-tools', 'interface')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('record expected')
  return value
}

async function check(id: string, hints: Record<string, unknown>, kinds: readonly string[], isIdempotent: boolean): Promise<string[]> {
  const generated = await loadJson(path.join(VALID, 'generated.json'))
  const authored = await loadYaml(path.join(VALID, 'authored.yaml'))
  if (generated.kind !== 'ok' || authored.kind !== 'ok') throw new Error('fixture must load')
  const generatedData = record(structuredClone(generated.data))
  const authoredData = record(structuredClone(authored.data))
  const entries = generatedData['entries']
  if (!Array.isArray(entries)) throw new TypeError('entries expected')
  for (const item of entries) {
    if (record(item)['id'] === id) record(record(item)['mcp'])['annotations'] = hints
  }
  const target = record(record(authoredData['entries'])[id])
  target['effects'] = kinds.map(kind => ({ target: 'aws', kind, what: 'x' }))
  target['idempotent'] = isIdempotent
  return validateDefinitions([{
    name: 'pecot-tools', root: 'plugins/pecot-tools', dirExists: true, mode: 'partial', sources: [],
    generated: { kind: 'ok', data: generatedData }, authored: { kind: 'ok', data: authoredData },
  }]).map(finding => `${finding.scope ?? ''}: ${finding.reason}`)
}

describe('effects against mcp.annotations', () => {
  it('MCP の annotations のヒントと effects が合っていると、定義書の検証を通す', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。`readOnlyHint` などのヒントが `effects` の種類と合っている場合に、検証エラーが出ないことを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-CP', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, ['write', 'destructive'], false)).toEqual([])
    })
  })

  it('readOnlyHint が true なのに effects に destructive があると、検証エラーにする', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。`effects` へ `destructive` を含め、`readOnlyHint` を `true` に指定した場合、食い違いを示す検証エラーが出ることを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-LS', { readOnlyHint: true }, ['read', 'destructive'], true))
        .toEqual(['PT-AWS-S3-LS: effects has kind "destructive" but annotations.readOnlyHint is true'])
    })
  })

  it('effects が read だけなのに readOnlyHint が false だと、検証エラーにする', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。`effects` を `read` だけにして `readOnlyHint` を `false` にした場合、食い違いを示す検証エラーが出ることを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-LS', { readOnlyHint: false }, ['read'], true))
        .toEqual(['PT-AWS-S3-LS: effects has no kind "write" or "destructive" but annotations.readOnlyHint is false'])
    })
  })

  it('effects が write だけなら、destructiveHint が false でも検証を通す', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。`effects` が `read` と `write` だけの場合に、`destructiveHint` が `false` でも検証エラーが出ないことを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-CP', { readOnlyHint: false, destructiveHint: false }, ['read', 'write'], true)).toEqual([])
    })
  })

  it('destructiveHint が effects の destructive と食い違うと、検証エラーにする', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。`destructiveHint` が `effects` の `destructive` の有無と食い違う場合に、それぞれ食い違いを示す検証エラーが出ることを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-CP', { destructiveHint: true }, ['write'], true))
        .toEqual(['PT-AWS-S3-CP: effects has no kind "destructive" but annotations.destructiveHint is true'])
      expect(await check('PT-AWS-S3-CP', { destructiveHint: false }, ['write', 'destructive'], true))
        .toEqual(['PT-AWS-S3-CP: effects has kind "destructive" but annotations.destructiveHint is false'])
    })
  })

  it('idempotentHint が idempotent と食い違うと、検証エラーにする', async () => {
    await explains('定義書の `idempotent` と、MCP の `annotations` のヒントの整合を検証するテストです。`idempotentHint` が `true` で `idempotent` が `false` の場合に、食い違いを示す検証エラーが出ることを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-CP', { idempotentHint: true }, ['write'], false))
        .toEqual(['PT-AWS-S3-CP: idempotent is false but annotations.idempotentHint is true'])
    })
  })

  it('MCP の annotations にヒントが含まれていないと、effects との整合を検証しない', async () => {
    await explains('定義書の `effects` と、MCP の `annotations` のヒントの整合を検証するテストです。ヒントが 1 つも含まれていない場合に、`effects` が `destructive` を含んでいても検証エラーが出ないことを確認します。')
    await step('ヒントと作用を比べ、出た問題を確かめる', async () => {
      expect(await check('PT-AWS-S3-CP', {}, ['write', 'destructive'], false)).toEqual([])
    })
  })
})
