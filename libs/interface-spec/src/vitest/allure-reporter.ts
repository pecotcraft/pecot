// vitest の reporters に足す allure-vitest の reporter。nx の外（NX_TASK_TARGET_TARGET が無い）では足さず、結果を残さない。
// interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
import path from 'node:path'
import AllureVitestReporter from 'allure-vitest/reporter'
import type { AllureVitestReporterConfig } from 'allure-vitest/reporter'

import { reportLabelsListener } from './report-labels.js'

const LOCAL_SITE_URL = 'http://localhost:8000/'

// generated.json の表を、reporter を作り直しても読み直さないように、1 つを使い回す。
const LABELS_LISTENER = reportLabelsListener()

// reporter を足すかどうか。verifies も同じ条件で Allure の runtime を呼ぶ。
export function isAllureEnabled(environment: Readonly<NodeJS.ProcessEnv>): boolean {
  const target = environment['NX_TASK_TARGET_TARGET']
  return target !== undefined && target !== ''
}

export function allureReporterConfig(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): AllureVitestReporterConfig | undefined {
  if (!isAllureEnabled(environment)) return undefined
  const target = environment['NX_TASK_TARGET_TARGET'] ?? ''
  const site = environment['PECOT_REPORT_SITE_URL']
  const siteUrl = site === undefined || site === '' ? LOCAL_SITE_URL : (site.endsWith('/') ? site : `${site}/`)
  const project = environment['NX_TASK_TARGET_PROJECT'] ?? ''
  return {
    resultsDir: path.join(projectRoot, 'test-results', target, 'allure-results'),
    globalLabels: [
      { name: 'project', value: project },
      { name: 'lane', value: target },
      { name: 'epic', value: project },
    ],
    links: { tms: { urlTemplate: `${siteUrl}permalink.html?id=%s`, nameTemplate: '%s' } },
    listeners: [LABELS_LISTENER],
  }
}

// パスでなく instance で渡す。パスだと knip がプラグインの設定から allure-vitest を未宣言の依存と読むため。
export function allureReporter(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): AllureVitestReporter[] {
  const config = allureReporterConfig(projectRoot, environment)
  return config === undefined ? [] : [new AllureVitestReporter(config)]
}
