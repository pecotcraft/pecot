import { describe, expect, it } from 'vitest'

import type { DependabotResult, DependabotSource } from '../dependabot-source.js'

// 取得元の契約: 結果は kind で判別でき、失敗の kind は失敗の情報（network は message）を持つ。
// 実体（GitHub）は infra、利用側（判定）は domain/dependabot.ts が持つ。ここはメモリ上の実装で形を固定する。
function memorySource(results: {
  readonly alerts: DependabotResult<readonly string[]>
  readonly enabled: DependabotResult<boolean>
}): DependabotSource {
  return {
    listOpenAlerts: () => Promise.resolve(results.alerts),
    isAlertsEnabled: () => Promise.resolve(results.enabled),
  }
}

describe('DependabotSource', () => {
  it('ok は value を持つ', async () => {
    const source = memorySource({ alerts: { kind: 'ok', value: ['a', 'b'] }, enabled: { kind: 'ok', value: true } })
    await expect(source.listOpenAlerts('o', 'r')).resolves.toEqual({ kind: 'ok', value: ['a', 'b'] })
    await expect(source.isAlertsEnabled('o', 'r')).resolves.toEqual({ kind: 'ok', value: true })
  })

  it('forbidden・rateLimited・failure は failure を、network は message を持つ', async () => {
    const failure = { message: 'x', statusCode: 403, responseBody: undefined }
    const kinds: readonly DependabotResult<boolean>[] = [
      { kind: 'forbidden', failure },
      { kind: 'rateLimited', failure },
      { kind: 'failure', failure },
      { kind: 'network', message: 'timeout' },
    ]
    for (const result of kinds) {
      const source = memorySource({ alerts: { kind: 'network', message: 'n' }, enabled: result })
      await expect(source.isAlertsEnabled('o', 'r')).resolves.toBe(result)
    }
    expect(kinds.map(result => result.kind)).toEqual(['forbidden', 'rateLimited', 'failure', 'network'])
  })
})
