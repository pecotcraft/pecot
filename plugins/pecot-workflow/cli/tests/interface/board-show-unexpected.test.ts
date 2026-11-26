// board show が、API 以外の例外を受けた時の振る舞い（PW-BOARD-SHOW-12）を確かめる。
// 偽サーバの応答ではこの例外を起こせないので、alert の収集を投げる関数に差し替える。
import { describe, expect, it, vi } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { graphqlRule, runCommand, runTool } from '../_helpers/command-harness.js'
import { verifies } from '../_helpers/verifies.js'

vi.mock(import('@pecot/workflow-core/commands-shared/board-view.js'), async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    collectAlertStatuses: () => {
      throw new TypeError('boom')
    },
  }
})

useIsolatedEnvironment()

describe('board show', () => {
  const emptyBoard = graphqlRule('ListProjectItems', { node: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: undefined } } } })

  it('予期しないエラーが起きると、終了コード 1 で終わる', async () => {
    const result = await runCommand({
      argv: ['board', 'show'],
      github: [emptyBoard],
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: unexpected error: boom\n')
  })

  it('MCP で予期しないエラーが起きると、kind が other の失敗を返す', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-12')
    const result = await runTool({ tool: 'board_show', arguments: {}, github: [emptyBoard] })
    expect(result.isError).toBe(true)
    expect(result.structured).toEqual({ kind: 'other', detail: 'unexpected error: boom' })
  })
})
