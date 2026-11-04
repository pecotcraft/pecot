import { describe, expect, it } from 'vitest'

import type {
  PipelineError,
  PipelineResult,
  PipelineTiming,
  SlideStep,
} from '../types.js'

describe('SlideStep 型', () => {
  it('clickStep null / 数値の双方を構築できる', () => {
    // eslint-disable-next-line unicorn/no-null -- clickStep 未指定の表現
    const a: SlideStep = { slideNumber: 1, clickStep: null, url: 'http://localhost/1' }
    const b: SlideStep = { slideNumber: 5, clickStep: 3, url: 'http://localhost/5?clicks=3' }
    expect(a.clickStep).toBeNull()
    expect(b.clickStep).toBe(3)
  })
})

describe('PipelineError 型', () => {
  it('slide / element 双方の level を表現できる', () => {
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
  it('PipelineResult は PipelineTiming + errors / warnings 配列を保持する', () => {
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
