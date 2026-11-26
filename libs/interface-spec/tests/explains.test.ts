import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime, TestRuntime } from 'allure-js-commons/sdk/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as subject from '../src/vitest/explains.js'
import { explains } from '../src/vitest/explains.js'
import { stepSync } from '../src/vitest/step.js'

// allure-js-commons 3.15.0 の sync の型（undefined を含む）は、exactOptionalPropertyTypes の下で TestRuntime に合わない。
class HolderRuntime extends MessageHolderTestRuntime {
  override get sync(): SyncTestRuntime {
    const sync = super.sync
    if (sync === undefined) throw new Error('MessageHolderTestRuntime に sync が無い')
    return sync
  }
}

// レーンの中では、allure-vitest の expect も step を runtime に送るので、metadata の description だけを見る。
function descriptions(messages: readonly RuntimeMessage[]): string[] {
  const found: string[] = []
  for (const message of messages) {
    if (message.type !== 'metadata') continue
    if (message.data.description !== undefined) found.push(message.data.description)
  }
  return found
}

describe('explains', () => {
  let previous: TestRuntime | undefined

  // テスト自身の説明を本物の runtime に残してから差し替えるので、beforeEach でなく本体で呼ぶ。
  function holdRuntime(): HolderRuntime {
    previous = getGlobalTestRuntime()
    const runtime = new HolderRuntime()
    setGlobalTestRuntime(runtime)
    return runtime
  }

  // step は本物の runtime とレーンの環境に戻してから書く。
  function restoreRuntime(): void {
    if (previous !== undefined) setGlobalTestRuntime(previous)
    previous = undefined
    vi.unstubAllEnvs()
  }

  afterEach(restoreRuntime)

  it('nx のレーンの中では、渡した説明を Allure に 1 つだけ送る', async () => {
    await explains('nx のレーンの中で実行した場合（`NX_TASK_TARGET_TARGET` が設定されている場合）に、渡した説明を Allure へ 1 つだけ送信することを確認します。')
    const runtime = holdRuntime()
    vi.stubEnv('NX_TASK_TARGET_TARGET', 'test-unit')
    await subject.explains('説明の文です。')
    restoreRuntime()
    stepSync('Allure に送った説明を比べる', () => {
      expect(descriptions(runtime.messages())).toEqual(['説明の文です。'])
    })
  })

  it('NX_TASK_TARGET_TARGET が空の場合は、説明を Allure に送らない', async () => {
    await explains('nx のレーンの外で実行した場合（`NX_TASK_TARGET_TARGET` が空の場合）に、Allure へ説明を送信しないことを確認します。')
    const runtime = holdRuntime()
    vi.stubEnv('NX_TASK_TARGET_TARGET', '')
    await subject.explains('説明の文です。')
    restoreRuntime()
    stepSync('Allure に説明を送っていないことを比べる', () => {
      expect(descriptions(runtime.messages())).toEqual([])
    })
  })
})
