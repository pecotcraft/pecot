// vitest の reporters に足す allure-vitest の reporter。nx の外（NX_TASK_TARGET_TARGET が無い）では足さず、結果を残さない。
// interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TestResult } from 'allure-js-commons'
import type { LifecycleListener } from 'allure-js-commons/sdk/reporter'
import AllureVitestReporter from 'allure-vitest/reporter'
import type { AllureVitestReporterConfig } from 'allure-vitest/reporter'

import { reportLabelsListener } from './report-labels.js'

const LOCAL_SITE_URL = 'http://localhost:8000/'
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'] as const
const OS_RELEASE_LINE = /^(?<name>\w+)=(?<quote>["']?)(?<value>.*)\k<quote>$/u
const OS_RELEASE_ESCAPE = /\\([\\$"'`])/gu

// generated.json の表を、reporter を作り直しても読み直さないように、1 つを使い回す。
const LABELS_LISTENER = reportLabelsListener()

// Node.js の版はレーンで違いうるので、テストのパラメータに置く。excluded で historyId の計算から外す。
const NODE_VERSION_LISTENER: LifecycleListener = {
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 渡された結果を書き換える
  beforeTestResultWrite: (result: TestResult) => {
    if (result.parameters.some(parameter => parameter.name === 'Node.js')) return
    result.parameters.push({ name: 'Node.js', value: process.version, excluded: true })
  },
}

// Python の platform.freedesktop_os_release() と同じ読み方にする。外側のクオートを外し、5 つの記号のエスケープを外す。
function prettyName(content: string): string | undefined {
  let value: string | undefined
  for (const line of content.split(/\r?\n/u)) {
    const match = OS_RELEASE_LINE.exec(line)
    if (match?.groups?.['name'] === 'PRETTY_NAME') value = (match.groups['value'] ?? '').replaceAll(OS_RELEASE_ESCAPE, '$1')
  }
  return value
}

function readOsRelease(readFile: (file: string) => string): string | undefined {
  for (const file of OS_RELEASE_FILES) {
    try {
      return readFile(file)
    }
    catch {
      continue
    }
  }
  return undefined
}

// os-release(5) の順に読む。/etc/os-release があればそれだけを、無ければ /usr/lib/os-release を読む。
export function osName(readFile: (file: string) => string = file => readFileSync(file, 'utf8')): string {
  const content = readOsRelease(readFile)
  return (content === undefined ? undefined : prettyName(content)) ?? `${os.type()} ${os.release()}`
}

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
    environmentInfo: { 'OS': osName(), 'Node.js': process.version },
    listeners: [LABELS_LISTENER, NODE_VERSION_LISTENER],
  }
}

// パスでなく instance で渡す。パスだと knip がプラグインの設定から allure-vitest を未宣言の依存と読むため。
export function allureReporter(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): AllureVitestReporter[] {
  const config = allureReporterConfig(projectRoot, environment)
  return config === undefined ? [] : [new AllureVitestReporter(config)]
}
