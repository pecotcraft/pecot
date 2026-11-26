import { describe, expect, it } from 'vitest'

import { formatHinted } from '../command-hint.js'
import { gitFailureText, gitReasonOf, logOf } from '../git-output.js'

const ADD_FAILURE = 'Preparing worktree (new branch \'wt1\')\nfatal: \'/w/occupied\' already exists\n'

describe('gitReasonOf', () => {
  it('fatal の行より前の進みの行を落とす', () => {
    expect(gitReasonOf(ADD_FAILURE)).toBe('fatal: \'/w/occupied\' already exists')
  })

  it('error の行から後は、続く行も残す', () => {
    expect(gitReasonOf('remote: counting\nerror: cannot lock ref\nhint: try again\n')).toBe('error: cannot lock ref\nhint: try again')
  })

  it('fatal と error の行が無ければ、前後の空白を除いた全文を返す', () => {
    expect(gitReasonOf(' ! [rejected] a -> a (fetch first)\n')).toBe('! [rejected] a -> a (fetch first)')
  })
})

describe('gitFailureText', () => {
  it('CLI では渡した文のまま、MCP では理由の行だけを前置きに続ける', () => {
    const text = gitFailureText('failed to create the worktree: ', ADD_FAILURE)
    expect(formatHinted(text, 'cli')).toBe(`failed to create the worktree: ${ADD_FAILURE}`)
    expect(formatHinted(text, 'mcp')).toBe('failed to create the worktree: fatal: \'/w/occupied\' already exists')
  })
})

function withLog(log: unknown): Error {
  return Object.assign(new Error('x'), { log })
}

describe('logOf', () => {
  it('例外が文字列の log を持てば、それを返す', () => {
    expect(logOf(withLog(ADD_FAILURE))).toBe(ADD_FAILURE)
  })

  it('log が無いか、空白だけか、文字列でなければ、undefined を返す', () => {
    expect(logOf(new Error('x'))).toBeUndefined()
    expect(logOf(withLog(' \n'))).toBeUndefined()
    expect(logOf(withLog(1))).toBeUndefined()
    expect(logOf('x')).toBeUndefined()
  })
})
