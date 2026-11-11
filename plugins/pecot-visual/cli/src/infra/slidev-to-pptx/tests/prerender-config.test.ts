import { describe, expect, it } from 'vitest'

import { prerenderConfig, type PrerenderConfig, type PrerenderTarget, type WaitStrategy } from '../prerender-config.js'

describe('prerenderConfig', () => {
  it('targets / defaultWaitStrategy / deviceScaleFactor / pptxImageScale を持つ', () => {
    expect(prerenderConfig.targets.length).toBeGreaterThan(0)
    expect(prerenderConfig.defaultWaitStrategy.type).toBe('fixed')
    expect(prerenderConfig.deviceScaleFactor).toBeGreaterThan(0)
    expect(prerenderConfig.pptxImageScale).toBeGreaterThan(0)
  })

  it('targets はすべて selector を持ち、waitStrategy が指定された target は kind が selectorState もしくは fixed', () => {
    for (const target of prerenderConfig.targets) {
      expect(typeof target.selector).toBe('string')
      if (target.waitStrategy) {
        expect(['fixed', 'selectorState']).toContain(target.waitStrategy.type)
      }
    }
  })

  it('PrerenderTarget・WaitStrategy・PrerenderConfig の値を作ると、入れた selector・type・倍率のままになる', () => {
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
