import type { RuntimeMessage } from 'allure-js-commons/sdk'
import { getGlobalTestRuntime, MessageHolderTestRuntime, setGlobalTestRuntime } from 'allure-js-commons/sdk/runtime'
import type { SyncTestRuntime, TestRuntime } from 'allure-js-commons/sdk/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { verifies } from '../src/vitest/verifies.js'
import type { AnnotatingContext } from '../src/vitest/verifies.js'
import { stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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

// 差し替えの間に呼んだ step は reporter でなくここに入るので、差し替えは操作だけに限り、終わったら戻す。
async function recorded(target: string, body: () => Promise<void>): Promise<readonly RuntimeMessage[]> {
  const previous: TestRuntime = getGlobalTestRuntime()
  const runtime = new HolderRuntime()
  setGlobalTestRuntime(runtime)
  vi.stubEnv('NX_TASK_TARGET_TARGET', target)
  try {
    await body()
  }
  finally {
    setGlobalTestRuntime(previous)
    vi.unstubAllEnvs()
  }
  return runtime.messages()
}

describe('verifies', () => {
  describe('Allure の reporter が動くレーンの中', () => {
    it('ID を渡すと、annotate に、ID と種類 verifies を渡す', async () => {
      await explains('テストと振る舞いの項目を結び付ける `verifies` のテストです。nx のレーンの中で ID を渡した場合に、vitest の `annotate` が、その ID と種類 `verifies` で 1 回呼び出されることを確認します。')
      const { context, annotate } = fakeContext()
      await recorded('test-unit', () => verifies(context, 'SM-ONE-02'))
      stepSync('annotate の呼び出しを比べる', () => {
        expect(annotate.mock.calls).toEqual([['SM-ONE-02', 'verifies']])
      })
    })

    it('ID を渡すと、型が tms で、URL と名前が ID のリンクを 1 つ追加する', async () => {
      await explains('テストと振る舞いの項目を結び付ける `verifies` のテストです。nx のレーンの中で ID を渡した場合に、Allure に型 `tms` で、URL と名前が ID のリンクが 1 つだけ追加されることを確認します。')
      const messages = await recorded('test-unit', () => verifies(fakeContext().context, 'SM-ONE-02'))
      stepSync('残したリンクを比べる', () => {
        expect(metadata(messages).links).toEqual([{ type: 'tms', url: 'SM-ONE-02', name: 'SM-ONE-02' }])
      })
    })

    it('ID を渡すと、名前が tag で、値が ID のラベルを 1 つ追加する', async () => {
      await explains('テストと振る舞いの項目を結び付ける `verifies` のテストです。nx のレーンの中で ID を渡した場合に、Allure に名前 `tag` で、値が ID のラベルが 1 つだけ追加されることを確認します。')
      const messages = await recorded('test-unit', () => verifies(fakeContext().context, 'SM-ONE-02'))
      stepSync('残したラベルを比べる', () => {
        expect(metadata(messages).labels).toEqual([{ name: 'tag', value: 'SM-ONE-02' }])
      })
    })

    it('2 つの ID を渡すと、リンクと tag のラベルを 2 つずつ追加する', async () => {
      await explains('テストと振る舞いの項目を結び付ける `verifies` のテストです。nx のレーンの中で ID を 2 つ渡した場合に、Allure のリンクと `tag` のラベルが、2 つずつ追加されることを確認します。')
      const { context } = fakeContext()
      const messages = await recorded('test-unit', async () => {
        await verifies(context, 'SM-ONE-02')
        await verifies(context, 'SM-TWO-01')
      })
      stepSync('残したリンクと tag を比べる', () => {
        expect(metadata(messages)).toEqual({
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
  })

  it('NX_TASK_TARGET_TARGET が空だと、annotate だけを呼び出し、リンクと tag のラベルは追加しない', async () => {
    await explains('nx のレーンの外で実行した場合（`NX_TASK_TARGET_TARGET` が空の場合）に、`annotate` だけを呼び出し、Allure のリンクと `tag` のラベルを追加しないことを確認します。')
    const { context, annotate } = fakeContext()
    const messages = await recorded('', () => verifies(context, 'SM-ONE-02'))
    stepSync('annotate の呼び出しと残したメタデータを比べる', () => {
      expect(annotate.mock.calls).toEqual([['SM-ONE-02', 'verifies']])
      expect(metadata(messages)).toEqual({ links: [], labels: [] })
    })
  })
})
