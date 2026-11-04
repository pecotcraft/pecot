import { describe, expect, it } from 'vitest'

import { SSO_TOOL_NAMES } from '../../../../tests/_helpers/sso-tool-names.js'
import { ALLOWLIST } from '../../../domain/allowlist.js'
import { allTools } from '../index.js'

describe('allTools', () => {
  it('SSO の 2 件に続けて許可リストの 24 件を同じ並びで公開する', () => {
    // 並びの元は「SSO 2 件 + 許可リスト」。契約表との突き合わせは
    // src/mcp/tests/contract.test.ts が持つ。
    expect(allTools()).toHaveLength(26)
    expect(allTools().map(tool => tool.name)).toEqual([
      ...SSO_TOOL_NAMES,
      ...ALLOWLIST.map(entry => entry.toolName),
    ])
  })

  it('引数を省略しても既定値で組み立てられる', () => {
    // serve.ts は allTools() を引数なしで呼ぶ。
    expect(allTools().map(tool => tool.name)).toEqual(allTools({}).map(tool => tool.name))
  })
})
