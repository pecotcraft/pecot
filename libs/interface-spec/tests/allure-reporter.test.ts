import path from 'node:path'
import AllureVitestReporter from 'allure-vitest/reporter'
import { describe, expect, it } from 'vitest'
import { allureReporter, allureReporterConfig } from '../src/vitest/allure-reporter.js'

const ROOT = path.join(path.sep, 'repo', 'plugins', 'pecot-tools')
const NX_ENV = { NX_TASK_TARGET_PROJECT: 'pecot-tools', NX_TASK_TARGET_TARGET: 'test-cli' }

describe('allureReporterConfig', () => {
  it('NX_TASK_TARGET_TARGET が無いと、設定を返さない', () => {
    expect(allureReporterConfig(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toBeUndefined()
  })

  it('NX_TASK_TARGET_TARGET が空文字だと、設定を返さない', () => {
    expect(allureReporterConfig(ROOT, { ...NX_ENV, NX_TASK_TARGET_TARGET: '' })).toBeUndefined()
  })

  it('結果を project の root の下の test-results/<target>/allure-results に書く', () => {
    expect(allureReporterConfig(ROOT, NX_ENV)?.resultsDir).toBe(path.join(ROOT, 'test-results', 'test-cli', 'allure-results'))
  })

  it('project と lane のラベルを、nx の task の値で付ける', () => {
    expect(allureReporterConfig(ROOT, NX_ENV)?.globalLabels).toEqual([
      { name: 'project', value: 'pecot-tools' },
      { name: 'lane', value: 'test-cli' },
    ])
  })

  it('PECOT_REPORT_SITE_URL が無いと、tms のリンクを手元のサイトに向ける', () => {
    expect(allureReporterConfig(ROOT, NX_ENV)?.links).toEqual({
      tms: { urlTemplate: 'http://localhost:8000/permalink.html?id=%s', nameTemplate: '%s' },
    })
  })

  it('PECOT_REPORT_SITE_URL があると、tms のリンクをその URL に向ける', () => {
    const config = allureReporterConfig(ROOT, { ...NX_ENV, PECOT_REPORT_SITE_URL: 'https://example.github.io/pecot/' })
    expect(config?.links?.tms?.urlTemplate).toBe('https://example.github.io/pecot/permalink.html?id=%s')
  })
})

describe('allureReporter', () => {
  it('NX_TASK_TARGET_TARGET が無いと、reporter を足さない', () => {
    expect(allureReporter(ROOT, { NX_TASK_TARGET_PROJECT: 'pecot-tools' })).toEqual([])
  })

  it('NX_TASK_TARGET_TARGET があると、allure-vitest の reporter を、同じ env の設定で 1 つ返す', () => {
    const reporters = allureReporter(ROOT, NX_ENV)
    expect(reporters).toHaveLength(1)
    expect(reporters[0]).toBeInstanceOf(AllureVitestReporter)
    expect(reporters[0]).toHaveProperty('config', allureReporterConfig(ROOT, NX_ENV))
  })
})
