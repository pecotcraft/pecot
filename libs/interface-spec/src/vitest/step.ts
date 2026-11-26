// テストの操作と確かめを、名前の付いた Allure の step として残す。名前は「何を・どうする」で書く（.claude/rules/test-conventions.md）。
// interface-env: NX_TASK_TARGET_TARGET
import { step as allureStep } from 'allure-js-commons'
import { step as allureStepSync } from 'allure-js-commons/sync'

import { isAllureEnabled } from './allure-reporter.js'

// reporter の無いところで呼ぶと、allure-js-commons が呼ぶたびに警告を標準出力に出す。外では本体を呼ぶだけにする。
export async function step<T>(name: string, body: () => T | PromiseLike<T>): Promise<T> {
  return isAllureEnabled(process.env) ? await allureStep(name, body) : await body()
}

// 本体が同期のテスト向け。allure-vitest の README の「Sync API」の案内どおり、allure-js-commons/sync の step を使う。
export function stepSync<T>(name: string, body: () => T): T {
  return isAllureEnabled(process.env) ? allureStepSync(name, body) : body()
}
