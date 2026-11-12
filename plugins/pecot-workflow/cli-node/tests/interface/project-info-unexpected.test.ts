// project info が、API 以外の例外を受けた時の振る舞い（PW-PROJECT-INFO-12）を確かめる。
// 偽サーバの応答ではこの例外を起こせないので、alert の収集を投げる関数に差し替える。
import { describe, expect, it, vi } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { graphqlRule, runCommand } from '../_helpers/command-harness.js'
import { verifies } from '../_helpers/verifies.js'

vi.mock(import('../../src/commands/project-info.js'), async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    collectAlertStatuses: () => {
      throw new TypeError('boom')
    },
  }
})

useIsolatedEnvironment()

describe('project info', () => {
  it('予期しないエラーが起きると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-12')
    const result = await runCommand({
      argv: ['project', 'info'],
      github: [graphqlRule('ListProjectItems', { node: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: undefined } } } })],
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: unexpected error: boom\n')
  })
})
