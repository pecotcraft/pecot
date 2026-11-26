import { describe, expect, it } from 'vitest'

import type {
  PipelineError,
  PipelineResult,
  PipelineTiming,
  SlideStep,
} from '../types.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('SlideStep 型', () => {
  it('clickStep に null と数値を入れると、入れた値のまま保持する', async () => {
    await explains('スライドの変換単位を表す `SlideStep` 型のテストです。`clickStep` に `null` と数値を入れた場合に、どちらも入れた値のまま保持されることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- clickStep 未指定の表現
    const a: SlideStep = { slideNumber: 1, clickStep: null, url: 'http://localhost/1' }
    const b: SlideStep = { slideNumber: 5, clickStep: 3, url: 'http://localhost/5?clicks=3' }
    expect(a.clickStep).toBeNull()
    expect(b.clickStep).toBe(3)
  })
})

describe('PipelineError 型', () => {
  it('level に slide と element を入れると、入れた値のまま保持する', async () => {
    await explains('変換のエラーを表す `PipelineError` 型のテストです。`level` に `slide` と `element` を入れた場合に、入れた値のまま保持され、`element` では `selector` も読み取れることを確認します。')
    const slide: PipelineError = { level: 'slide', slideNumber: 2, message: 'failed' }
    const element: PipelineError = {
      level: 'element',
      slideNumber: 3,
      selector: '.foo',
      message: 'oops',
    }
    expect(slide.level).toBe('slide')
    expect(element.selector).toBe('.foo')
  })
})

describe('PipelineTiming / PipelineResult 型', () => {
  it('PipelineResult は、PipelineTiming と errors・warnings の配列を保持する', async () => {
    await explains('変換の結果を表す `PipelineResult` 型のテストです。`timing`・`errors`・`warnings` を指定した結果を作成した場合に、スライドごとの時間と警告の件数が読み取れることを確認します。')
    const timing: PipelineTiming = {
      total: 1,
      scan: 0.1,
      phase1: 0.5,
      phase2: 0.4,
      perSlide: { '1': 0.2, '2/1': 0.3 },
    }
    const result: PipelineResult = {
      success: true,
      slideCount: 2,
      slidesDirectory: '/abs/out/slides',
      errors: [],
      warnings: ['css timed out'],
      timing,
    }
    expect(result.timing.perSlide['1']).toBe(0.2)
    expect(result.warnings).toHaveLength(1)
  })
})
