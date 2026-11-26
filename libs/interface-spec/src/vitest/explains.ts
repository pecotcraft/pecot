// テストが何を確かめるかの説明を、Allure の description で残す。書き方は .claude/rules/test-conventions.md の「説明の書き方」。
// interface-env: NX_TASK_TARGET_TARGET
import { description } from 'allure-js-commons'

import { isAllureEnabled } from './allure-reporter.js'

export async function explains(text: string): Promise<void> {
  // reporter の無いところで呼ぶと、allure-js-commons が呼ぶたびに警告を標準出力に出す。
  if (!isAllureEnabled(process.env)) return
  await description(text)
}
