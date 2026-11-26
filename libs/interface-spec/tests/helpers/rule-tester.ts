import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { step } from '../../src/vitest/step.js'

type Register = (name: string, body: () => Promise<void>) => void

// RuleTester が作るケースにも、名前の付いた step を持たせる。
function withStep(register: Register): (text: string, body: () => unknown) => void {
  return (text, body) => {
    register(text, async () => {
      await step('規則に valid / invalid のコードを通し、結果を比べる', async () => {
        await body()
      })
    })
  }
}

export function useVitestForRuleTester(): void {
  RuleTester.describe = describe
  RuleTester.it = withStep(it)
  RuleTester.itOnly = withStep(it.only)
}
