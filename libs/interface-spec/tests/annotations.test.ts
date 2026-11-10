import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDefinitions } from '../src/domain/validate.js'
import { loadJson, loadYaml } from '../src/infra/load.js'

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
    name: 'pecot-tools', dirExists: true, mode: 'partial', sources: [],
    generated: { kind: 'ok', data: generatedData }, authored: { kind: 'ok', data: authoredData },
  }]).map(finding => `${finding.scope ?? ''}: ${finding.reason}`)
}

describe('effects against mcp.annotations', () => {
  it('passes when they agree', async () => {
    expect(await check('PT-AWS-S3-CP', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, ['write', 'destructive'], false)).toEqual([])
  })

  it('rejects a destructive effect under readOnlyHint true', async () => {
    expect(await check('PT-AWS-S3-LS', { readOnlyHint: true }, ['read', 'destructive'], true))
      .toEqual(['PT-AWS-S3-LS: effects has kind "destructive" but annotations.readOnlyHint is true'])
  })

  it('rejects readOnlyHint false without a write or destructive effect', async () => {
    expect(await check('PT-AWS-S3-LS', { readOnlyHint: false }, ['read'], true))
      .toEqual(['PT-AWS-S3-LS: effects has no kind "write" or "destructive" but annotations.readOnlyHint is false'])
  })

  it('rejects destructiveHint that disagrees with effects', async () => {
    expect(await check('PT-AWS-S3-CP', { destructiveHint: true }, ['write'], true))
      .toEqual(['PT-AWS-S3-CP: effects has no kind "destructive" but annotations.destructiveHint is true'])
    expect(await check('PT-AWS-S3-CP', { destructiveHint: false }, ['write', 'destructive'], true))
      .toEqual(['PT-AWS-S3-CP: effects has kind "destructive" but annotations.destructiveHint is false'])
  })

  it('rejects idempotentHint that disagrees with idempotent', async () => {
    expect(await check('PT-AWS-S3-CP', { idempotentHint: true }, ['write'], false))
      .toEqual(['PT-AWS-S3-CP: idempotent is false but annotations.idempotentHint is true'])
  })

  it('does not compare hints that are absent', async () => {
    expect(await check('PT-AWS-S3-CP', {}, ['write', 'destructive'], false)).toEqual([])
  })
})
