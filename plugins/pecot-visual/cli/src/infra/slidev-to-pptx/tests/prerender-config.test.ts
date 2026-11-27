import { describe, expect, it } from 'vitest'

import { prerenderConfig, type PrerenderConfig, type PrerenderTarget, type WaitStrategy } from '../prerender-config.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('prerenderConfig', () => {
  it('prerenderConfig に、対象・既定の待機方法・倍率が設定されている', async () => {
    await explains('プリレンダの設定値（`prerenderConfig`）のテストです。`targets` が 1 件以上あり、既定の待機方法が `fixed` で、`deviceScaleFactor` と `pptxImageScale` が正の数であることを確認します。')
    expect(prerenderConfig.targets.length).toBeGreaterThan(0)
    expect(prerenderConfig.defaultWaitStrategy.type).toBe('fixed')
    expect(prerenderConfig.deviceScaleFactor).toBeGreaterThan(0)
    expect(prerenderConfig.pptxImageScale).toBeGreaterThan(0)
  })

  it('すべての対象が selector を持ち、待機方法を指定した対象の種別は selectorState か fixed のどちらかになる', async () => {
    await explains('`prerenderConfig.targets` の各要素のテストです。すべての対象が文字列の `selector` を持ち、`waitStrategy` を指定した対象の `type` が `selectorState` か `fixed` のいずれかであることを確認します。')
    for (const target of prerenderConfig.targets) {
      expect(typeof target.selector).toBe('string')
      if (target.waitStrategy) {
        expect(['fixed', 'selectorState']).toContain(target.waitStrategy.type)
      }
    }
  })

  it('PrerenderTarget・WaitStrategy・PrerenderConfig の値を作ると、入れた selector・type・倍率のままになる', async () => {
    await explains('設定の型（`PrerenderTarget`・`WaitStrategy`・`PrerenderConfig`）に沿った値を作成した場合のテストです。作成した値の `selector`・`type`・`deviceScaleFactor` が、指定した値のまま取得できることを確認します。')
    const target: PrerenderTarget = { selector: '.foo' }
    const fixed: WaitStrategy = { type: 'fixed', delay: 100 }
    const sel: WaitStrategy = { type: 'selectorState', selector: '.x', state: 'detached' }
    const config: PrerenderConfig = {
      targets: [target],
      defaultWaitStrategy: fixed,
      deviceScaleFactor: 2,
      pptxImageScale: 1,
    }
    expect(target.selector).toBe('.foo')
    expect(sel.type).toBe('selectorState')
    expect(config.deviceScaleFactor).toBe(2)
  })
})
