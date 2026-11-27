import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
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
  it('取得に成功した場合は、結果が kind と value を持つ', async () => {
    await explains('Dependabot の alert の取得元（`DependabotSource`）が返す、成功の結果のテストです。alert の一覧と有効かどうかのどちらも、`kind` が `ok` で、`value` に取得した値を持つことを確認します。')
    const source = memorySource({ alerts: { kind: 'ok', value: ['a', 'b'] }, enabled: { kind: 'ok', value: true } })
    await expect(source.listOpenAlerts('o', 'r')).resolves.toEqual({ kind: 'ok', value: ['a', 'b'] })
    await expect(source.isAlertsEnabled('o', 'r')).resolves.toEqual({ kind: 'ok', value: true })
  })

  it('取得に失敗した場合は、forbidden・rateLimited・failure が failure を、network が message を持つ', async () => {
    await explains('Dependabot の alert の取得元（`DependabotSource`）が返す、失敗の結果のテストです。`forbidden`・`rateLimited`・`failure` は失敗の情報を、`network` は `message` を持ち、渡した結果がそのまま返ることを確認します。')
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
