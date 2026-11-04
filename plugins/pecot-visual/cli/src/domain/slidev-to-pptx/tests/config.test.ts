import { describe, expect, it } from 'vitest'

import { timeouts, type OnlySlideSpec, type PipelineConfig } from '../config.js'

describe('timeouts', () => {
  it('Slidev pipeline 内部の固定 timeout 値を保持する', () => {
    expect(timeouts).toStrictEqual({
      slidevReady: 30_000,
      scanStepNavigation: 5000,
      slideVisibility: 30_000,
      domToPptxInject: 30_000,
      slideRetryCount: 1,
      slideRetryDelay: 2000,
      cssAnimationSettle: 3000,
      iframeLoad: 5000,
      fontsReady: 5000,
      dataWaitfor: 15_000,
    })
  })

  it('ms 値はすべて非負の有限数', () => {
    for (const value of Object.values(timeouts)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('PipelineConfig 型', () => {
  it('必須フィールドを満たす値を構築できる', () => {
    const config: PipelineConfig = {
      presDir: '/abs/pres',
      templatePath: 'dist',
      outputDir: 'pptx',
      slidePrefix: 'slide-',
      port: 3002,
      // eslint-disable-next-line unicorn/no-null -- onlySlide 未指定の表現
      onlySlide: null,
      concurrency: 4,
      logLevel: 'normal',
    }
    expect(config.presDir).toBe('/abs/pres')
    expect(config.onlySlide).toBeNull()
  })

  it('onlySlide / onlySteps / skipPostprocess の optional / nullable を許容する', () => {
    const onlySlide: OnlySlideSpec = { slide: 5, click: 3 }
    const config: PipelineConfig = {
      presDir: '/abs',
      templatePath: 'dist',
      outputDir: 'pptx',
      slidePrefix: 'slide-',
      port: 3002,
      onlySlide,
      concurrency: 1,
      logLevel: 'verbose',
      skipPostprocess: true,
      onlySteps: [1, 2, 3],
    }
    expect(config.onlySlide?.slide).toBe(5)
    expect(config.skipPostprocess).toBe(true)
    expect(config.onlySteps).toStrictEqual([1, 2, 3])
  })
})
