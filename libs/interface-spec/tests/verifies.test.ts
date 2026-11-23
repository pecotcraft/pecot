import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime, TestRuntime } from 'allure-js-commons/sdk/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { verifies } from '../src/vitest/verifies.js'
import type { AnnotatingContext } from '../src/vitest/verifies.js'

// allure-js-commons 3.15.0 の sync の型（undefined を含む）は、exactOptionalPropertyTypes の下で TestRuntime に合わない。
class HolderRuntime extends MessageHolderTestRuntime {
  override get sync(): SyncTestRuntime {
    const sync = super.sync
    if (sync === undefined) throw new Error('MessageHolderTestRuntime に sync が無い')
    return sync
  }
}

interface FakeContext {
  readonly context: AnnotatingContext
  readonly annotate: Mock<AnnotatingContext['annotate']>
}

// verifies が使うのは annotate だけなので、それだけを持つ偽物を渡す。
function fakeContext(): FakeContext {
  const annotate = vi.fn<AnnotatingContext['annotate']>()
  return { context: { annotate }, annotate }
}

// レーンの中では、allure-vitest の expect も step を runtime に送るので、metadata だけを見る。
function metadata(messages: readonly RuntimeMessage[]): { links: unknown[], labels: unknown[] } {
  const links: unknown[] = []
  const labels: unknown[] = []
  for (const message of messages) {
    if (message.type !== 'metadata') continue
    links.push(...message.data.links ?? [])
    labels.push(...message.data.labels ?? [])
  }
  return { links, labels }
}

describe('verifies', () => {
  let previous: TestRuntime
  let runtime: HolderRuntime

  beforeEach(() => {
    previous = getGlobalTestRuntime()
    runtime = new HolderRuntime()
    setGlobalTestRuntime(runtime)
  })

  afterEach(() => {
    setGlobalTestRuntime(previous)
    vi.unstubAllEnvs()
  })

  describe('Allure の reporter が動くレーンの中', () => {
    beforeEach(() => {
      vi.stubEnv('NX_TASK_TARGET_TARGET', 'test-unit')
    })

    it('annotate に、ID と種類 verifies を渡す', async () => {
      const { context, annotate } = fakeContext()
      await verifies(context, 'SM-ONE-02')
      expect(annotate.mock.calls).toEqual([['SM-ONE-02', 'verifies']])
    })

    it('型 tms で、URL と名前が ID のリンクを 1 つ残す', async () => {
      await verifies(fakeContext().context, 'SM-ONE-02')
      expect(metadata(runtime.messages()).links).toEqual([{ type: 'tms', url: 'SM-ONE-02', name: 'SM-ONE-02' }])
    })

    it('名前 tag で、値が ID のラベルを 1 つ残す', async () => {
      await verifies(fakeContext().context, 'SM-ONE-02')
      expect(metadata(runtime.messages()).labels).toEqual([{ name: 'tag', value: 'SM-ONE-02' }])
    })

    it('2 つの ID を書くと、リンクと tag を 2 つずつ持つ', async () => {
      const { context } = fakeContext()
      await verifies(context, 'SM-ONE-02')
      await verifies(context, 'SM-TWO-01')
      expect(metadata(runtime.messages())).toEqual({
        links: [
          { type: 'tms', url: 'SM-ONE-02', name: 'SM-ONE-02' },
          { type: 'tms', url: 'SM-TWO-01', name: 'SM-TWO-01' },
        ],
        labels: [
          { name: 'tag', value: 'SM-ONE-02' },
          { name: 'tag', value: 'SM-TWO-01' },
        ],
      })
    })
  })

  it('NX_TASK_TARGET_TARGET が空だと、annotate だけを呼び、リンクと tag は残さない', async () => {
    vi.stubEnv('NX_TASK_TARGET_TARGET', '')
    const { context, annotate } = fakeContext()
    await verifies(context, 'SM-ONE-02')
    expect(annotate.mock.calls).toEqual([['SM-ONE-02', 'verifies']])
    expect(metadata(runtime.messages())).toEqual({ links: [], labels: [] })
  })
})
