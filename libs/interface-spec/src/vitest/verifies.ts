// テストが確かめる振る舞いの項目の ID を、vitest の annotation と、Allure の tms のリンク・tag で残す。
// interface-env: NX_TASK_TARGET_TARGET
import { tag, tms } from 'allure-js-commons'

import { isAllureEnabled } from './allure-reporter.js'

// vitest の TestContext のうち、verifies が使う annotate だけ。
export interface AnnotatingContext {
  readonly annotate: (message: string, type: string) => Promise<unknown>
}

export async function verifies(context: AnnotatingContext, id: string): Promise<void> {
  await context.annotate(id, 'verifies')
  // reporter の無いところで呼ぶと、allure-js-commons が呼ぶたびに警告を標準出力に出す。
  if (!isAllureEnabled(process.env)) return
  await tms(id, id)
  await tag(id)
}
