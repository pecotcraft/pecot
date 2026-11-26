// RuleTester のケースを vitest のテストとして登録し、valid と invalid で決まった説明と、名前の付いた step を付ける。
import type { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import { explains } from './explains.js'
import { step } from './step.js'

function descriptionOf(rule: string, kind: string): string {
  return kind === 'invalid'
    ? `ESLint の規則 \`${rule}\` に、違反のあるコードを読ませるテストです。ケースに書いたエラーの種類と位置で報告することを確認します。`
    : `ESLint の規則 \`${rule}\` に従ったコードを読ませるテストです。エラーを 1 つも報告しないことを確認します。`
}

// RuleTester は describe(規則の名前) の中に describe('valid') と describe('invalid') を作り、その中でケースごとに it を呼ぶ。
// vitest は describe の本体を後で呼ぶので、呼ばれた時点の題の並びを本体ごとに持たせる。
export function useExplainedRuleTester(tester: typeof RuleTester): void {
  let scopes: readonly string[] = []
  const register = (isOnly: boolean) => (title: string, body: () => unknown): void => {
    const [rule = '', kind = ''] = scopes
    const define = isOnly ? it.only : it
    define(title, async () => {
      await explains(descriptionOf(rule, kind))
      await step('規則に valid / invalid のコードを通し、結果を比べる', async () => {
        await body()
      })
    })
  }
  tester.describe = (title: string, body: () => void): void => {
    const path = [...scopes, title]
    describe(title, () => {
      const saved = scopes
      scopes = path
      try {
        body()
      }
      finally {
        scopes = saved
      }
    })
  }
  tester.it = register(false)
  tester.itOnly = register(true)
}
