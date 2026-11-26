import path from 'node:path'
import AllureVitestReporter from 'allure-vitest/reporter'
import { describe, expect, it } from 'vitest'
import { allureReporter, allureReporterConfig, isAllureEnabled } from '../src/vitest/allure-reporter.js'
import { stepSync } from '../src/vitest/step.js'

const ROOT = path.join(path.sep, 'repo', 'plugins', 'pecot-tools')
const NX_ENV = { NX_TASK_TARGET_PROJECT: 'pecot-tools', NX_TASK_TARGET_TARGET: 'test-cli' }

describe('isAllureEnabled', () => {
  it.for([
    { name: 'NX_TASK_TARGET_TARGET が無い', environment: { NX_TASK_TARGET_PROJECT: 'pecot-tools' }, expected: false },
    { name: 'NX_TASK_TARGET_TARGET が空文字', environment: { ...NX_ENV, NX_TASK_TARGET_TARGET: '' }, expected: false },
    { name: 'NX_TASK_TARGET_TARGET がある', environment: NX_ENV, expected: true },
  ])('$name とき、$expected を返す', ({ environment, expected }) => {
    stepSync('Allure の有効かを判定して比べる', () => {
      expect(isAllureEnabled(environment)).toBe(expected)
    })
  })
})

describe('allureReporterConfig', () => {
  it('NX_TASK_TARGET_TARGET が無いと、設定を返さない', () => {
    stepSync('設定を作り、未定義かを比べる', () => {
      expect(allureReporterConfig(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toBeUndefined()
    })
  })

  it('NX_TASK_TARGET_TARGET が空文字だと、設定を返さない', () => {
    stepSync('設定を作り、未定義かを比べる', () => {
      expect(allureReporterConfig(ROOT, { ...NX_ENV, NX_TASK_TARGET_TARGET: '' })).toBeUndefined()
    })
  })

  it('結果を project の root の下の test-results/<target>/allure-results に書く', () => {
    stepSync('設定を作り、結果の置き場を比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.resultsDir).toBe(path.join(ROOT, 'test-results', 'test-cli', 'allure-results'))
    })
  })

  it('project と lane のラベルを、nx の task の値で付ける', () => {
    stepSync('設定を作り、グローバルラベルを比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.globalLabels).toEqual([
        { name: 'project', value: 'pecot-tools' },
        { name: 'lane', value: 'test-cli' },
      ])
    })
  })

  it('PECOT_REPORT_SITE_URL が無いと、tms のリンクを手元のサイトに向ける', () => {
    stepSync('設定を作り、tms のリンクを比べる', () => {
      expect(allureReporterConfig(ROOT, NX_ENV)?.links).toEqual({
        tms: { urlTemplate: 'http://localhost:8000/permalink.html?id=%s', nameTemplate: '%s' },
      })
    })
  })

  it('PECOT_REPORT_SITE_URL があると、tms のリンクをその URL に向ける', () => {
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: 'https://example.github.io/pecot/' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('https://example.github.io/pecot/permalink.html?id=%s')
    })
  })

  it('PECOT_REPORT_SITE_URL が空文字だと、tms のリンクを手元のサイトに向ける', () => {
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: '' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('http://localhost:8000/permalink.html?id=%s')
    })
  })

  it('PECOT_REPORT_SITE_URL の末尾に / が無いと、/ を足してリンクを組む', () => {
    const config = stepSync('設定を作る', () => allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: 'https://example.github.io/pecot' }))
    stepSync('tms のリンクを比べる', () => {
      expect(config?.links?.tms?.urlTemplate).toBe('https://example.github.io/pecot/permalink.html?id=%s')
    })
  })
})

describe('allureReporter', () => {
  it('NX_TASK_TARGET_TARGET が無いと、reporter を足さない', () => {
    stepSync('reporter を作り、空かを比べる', () => {
      expect(allureReporter(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toEqual([])
    })
  })

  it('NX_TASK_TARGET_TARGET があると、allure-vitest の reporter を、同じ env の設定で 1 つ返す', () => {
    const reporters = stepSync('reporter を作る', () => allureReporter(ROOT, NX_ENV))
    stepSync('結果を比べる', () => {
      expect(reporters).toHaveLength(1)
      expect(reporters[0]).toBeInstanceOf(AllureVitestReporter)
      expect(reporters[0]).toHaveProperty('config', allureReporterConfig(ROOT, NX_ENV))
    })
  })
})
