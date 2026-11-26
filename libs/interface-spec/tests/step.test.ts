import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime } from 'allure-js-commons/sdk/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { step, stepSync } from '../src/vitest/step.js'

// allure-js-commons 3.15.0 の sync の型（undefined を含む）は、exactOptionalPropertyTypes の下で TestRuntime に合わない。
class HolderRuntime extends MessageHolderTestRuntime {
  override get sync(): SyncTestRuntime {
    const sync = super.sync
    if (sync === undefined) throw new Error('MessageHolderTestRuntime に sync が無い')
    return sync
  }
}

interface Recorded<T> {
  readonly value?: T
  readonly error?: unknown
  readonly steps: readonly { readonly type: string, readonly name?: string, readonly status?: string }[]
}

// runtime を差し替えて body を動かし、送られた step の message を返す。差し替えの間の step はテストの step にならないので、確かめの step はこの外で書く。
async function recorded<T>(target: string, body: () => T | Promise<T>): Promise<Recorded<T>> {
  const previous = getGlobalTestRuntime()
  const runtime = new HolderRuntime()
  setGlobalTestRuntime(runtime)
  vi.stubEnv('NX_TASK_TARGET_TARGET', target)
  try {
    return { value: await body(), steps: stepMessages(runtime.messages()) }
  }
  catch (error) {
    return { error, steps: stepMessages(runtime.messages()) }
  }
  finally {
    vi.unstubAllEnvs()
    setGlobalTestRuntime(previous)
  }
}

function stepMessages(messages: readonly RuntimeMessage[]): Recorded<unknown>['steps'] {
  const steps: Recorded<unknown>['steps'][number][] = []
  for (const message of messages) {
    if (message.type === 'step_start') steps.push({ type: message.type, name: message.data.name })
    else if (message.type === 'step_stop') steps.push({ type: message.type, status: message.data.status })
  }
  return steps
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('step', () => {
  it('レーンの中では、名前の付いた step を始めて閉じ、本体の値を返す', async () => {
    const result = await recorded('test-unit', () => step('CLI を動かす', () => Promise.resolve(42)))
    await step('送った step と値を比べる', () => {
      expect(result).toEqual({ value: 42, steps: [{ type: 'step_start', name: 'CLI を動かす' }, { type: 'step_stop', status: 'passed' }] })
    })
  })

  it('レーンの中で本体が投げると、step を失敗で閉じ、同じ例外を投げる', async () => {
    const thrown = new Error('本体が失敗した')
    const fail = (): never => {
      throw thrown
    }
    const result = await recorded('test-unit', () => step('CLI を動かす', fail))
    await step('送った step と例外を比べる', () => {
      expect(result).toEqual({ error: thrown, steps: [{ type: 'step_start', name: 'CLI を動かす' }, { type: 'step_stop', status: 'broken' }] })
    })
  })

  it('NX_TASK_TARGET_TARGET が空だと、step を送らずに本体の値を返す', async () => {
    const result = await recorded('', () => step('CLI を動かす', () => 'done'))
    await step('値と、送った step が無いことを確かめる', () => {
      expect(result).toEqual({ value: 'done', steps: [] })
    })
  })
})

describe('stepSync', () => {
  it('レーンの中では、名前の付いた step を始めて閉じ、本体の値をそのまま返す', async () => {
    const result = await recorded('test-unit', () => stepSync('規則にかける', () => 'ok'))
    stepSync('送った step と値を比べる', () => {
      expect(result).toEqual({ value: 'ok', steps: [{ type: 'step_start', name: '規則にかける' }, { type: 'step_stop', status: 'passed' }] })
    })
  })

  it('レーンの中で本体が投げると、step を失敗で閉じ、同じ例外を投げる', async () => {
    const thrown = new Error('本体が失敗した')
    const fail = (): never => {
      throw thrown
    }
    const result = await recorded('test-unit', () => stepSync('規則にかける', fail))
    stepSync('送った step と例外を比べる', () => {
      expect(result).toEqual({ error: thrown, steps: [{ type: 'step_start', name: '規則にかける' }, { type: 'step_stop', status: 'broken' }] })
    })
  })

  it('NX_TASK_TARGET_TARGET が空だと、step を送らずに本体の値を返す', async () => {
    const result = await recorded('', () => stepSync('規則にかける', () => 7))
    stepSync('値と、送った step が無いことを確かめる', () => {
      expect(result).toEqual({ value: 7, steps: [] })
    })
  })
})
