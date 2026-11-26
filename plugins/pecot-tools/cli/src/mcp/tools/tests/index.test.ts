import { describe, expect, it } from 'vitest'

import { SSO_TOOL_NAMES } from '../../../../tests/_helpers/sso-tool-names.js'
import { ALLOWLIST } from '../../../domain/allowlist.js'
import { allTools } from '../index.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('allTools', () => {
  it('SSO の 2 件に続けて、許可リストの 22 件を同じ並びで公開する', async () => {
    await explains('公開するツールの一覧を返す `allTools` のテストです。ツールが 24 件で、ツール名が SSO の 2 件、許可リストのツール名の順に並ぶことを確認します。')
    // 並びの元は「SSO 2 件 + 許可リスト」。契約表との突き合わせは
    // src/mcp/tests/contract.test.ts が持つ。
    expect(allTools()).toHaveLength(24)
    expect(allTools().map(tool => tool.name)).toEqual([
      ...SSO_TOOL_NAMES,
      ...ALLOWLIST.map(entry => entry.toolName),
    ])
  })

  it('引数を省略しても、既定値でツールの一覧を作成できる', async () => {
    await explains('公開するツールの一覧を返す `allTools` のテストです。引数を省略した場合と空のオブジェクトを渡した場合で、ツール名の並びが同じであることを確認します。')
    // serve.ts は allTools() を引数なしで呼ぶ。
    expect(allTools().map(tool => tool.name)).toEqual(allTools({}).map(tool => tool.name))
  })
})
