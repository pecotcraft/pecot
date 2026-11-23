// vitest の reporters に足す allure-vitest の reporter。nx の外（NX_TASK_TARGET_TARGET が無い）では足さず、結果を残さない。
// interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
import path from 'node:path'
import AllureVitestReporter from 'allure-vitest/reporter'
import type { AllureVitestReporterConfig } from 'allure-vitest/reporter'

const LOCAL_SITE_URL = 'http://localhost:8000/'

export function allureReporterConfig(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): AllureVitestReporterConfig | undefined {
  const target = environment['NX_TASK_TARGET_TARGET']
  if (target === undefined || target === '') return undefined
  const site = environment['PECOT_REPORT_SITE_URL']
  const siteUrl = site === undefined || site === '' ? LOCAL_SITE_URL : (site.endsWith('/') ? site : `${site}/`)
  return {
    resultsDir: path.join(projectRoot, 'test-results', target, 'allure-results'),
    globalLabels: [
      { name: 'project', value: environment['NX_TASK_TARGET_PROJECT'] ?? '' },
      { name: 'lane', value: target },
    ],
    links: { tms: { urlTemplate: `${siteUrl}permalink.html?id=%s`, nameTemplate: '%s' } },
  }
}

// パスでなく instance で渡す。パスだと knip がプラグインの設定から allure-vitest を未宣言の依存と読むため。
export function allureReporter(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): AllureVitestReporter[] {
  const config = allureReporterConfig(projectRoot, environment)
  return config === undefined ? [] : [new AllureVitestReporter(config)]
}
