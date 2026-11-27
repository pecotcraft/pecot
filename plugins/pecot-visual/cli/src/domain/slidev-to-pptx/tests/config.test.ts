import { describe, expect, it } from 'vitest'

import { timeouts, type OnlySlideSpec, type PipelineConfig } from '../config.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('timeouts', () => {
  it('Slidev の変換処理で使う固定のタイムアウト値を、定めた値のまま保持する', async () => {
    await explains('変換処理の設定 `timeouts` のテストです。`slidevReady`・`slideVisibility`・`fontsReady` などの各値が、定めた値と一致することを確認します。')
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

  it('タイムアウトの値は、すべて 0 以上の有限の数になる', async () => {
    await explains('変換処理の設定 `timeouts` のテストです。すべての値が有限の数で、0 以上であることを確認します。')
    for (const value of Object.values(timeouts)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('PipelineConfig 型', () => {
  it('必須の項目をすべて指定した設定は、presDir と onlySlide が指定した値のままになる', async () => {
    await explains('変換処理の設定の型 `PipelineConfig` のテストです。必須の項目をすべて指定した場合に、`presDir` が指定した値で、`onlySlide` が `null` になることを確認します。')
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

  it('onlySlide・onlySteps・skipPostprocess は、省略できる項目として受け付ける', async () => {
    await explains('変換処理の設定の型 `PipelineConfig` のテストです。`onlySlide`・`onlySteps`・`skipPostprocess` を指定した設定が作成でき、指定した値がそのまま読み取れることを確認します。')
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
