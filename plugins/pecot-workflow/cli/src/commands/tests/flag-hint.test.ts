// 入力の誤りの文のフラグ名。CLI ではフラグの形で出す（MCP の形は domain の repository-policy・pull-request のテストが見る）
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { runCommand } from '../../../tests/_helpers/command-harness.js'

useIsolatedEnvironment()

describe('入力の誤りの文のフラグ名', () => {
  it.for([
    { name: 'issue block の --wait merge に理由が無い', argv: ['issue', 'block', 'acme/demo/7', '--by', 'acme/demo/8', '--wait', 'merge'], expected: 'error: --reason is required with --wait merge\n' },
    { name: 'issue block の --wait stack に理由がある', argv: ['issue', 'block', 'acme/demo/7', '--by', 'acme/demo/8', '--wait', 'stack', '--reason', 'x'], expected: 'error: --reason is only valid with --wait merge\n' },
    { name: 'issue create の --prepare に --repo が無い', argv: ['issue', 'create', '--prepare', '--template', 'task'], expected: 'error: --repo <owner/repo> is required with --prepare unless --template epic\n' },
    { name: 'issue create の -m に -t が無い', argv: ['issue', 'create', '-m', 'body'], expected: 'error: --title is required with --message\n' },
    { name: 'pr create の -m に -t と -b が無い', argv: ['pr', 'create', '-m', 'body'], expected: 'error: --title and --base (base branch) are required with --message\n' },
    { name: 'pr create の --template が不正', argv: ['pr', 'create', '--template', 'x'], expected: 'error: --template must be \'default\' or \'release\' (given: x)\n' },
    { name: 'project link の --package と --changelog-file', argv: ['project', 'link', 'acme/other', '--package', 'a:b', '--changelog-file', 'c'], expected: 'error: --package and --changelog-file cannot be used together\n' },
    { name: 'project link の --package に区切りが無い', argv: ['project', 'link', 'acme/other', '--package', 'bad'], expected: 'error: give --package <NAME:PATH>: \'bad\'\n' },
  ])('$name とき、フラグの形で止める', async ({ argv, expected }) => {
    const result = await runCommand({ argv })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toBe(expected)
    expect(result.requests).toEqual([])
  })

  it.for([
    { name: 'issue block', argv: ['issue', 'block', '7', '--by', 'acme/demo/8'] },
    { name: 'pr show', argv: ['pr', 'show', '7'] },
  ])('git の外で $name に短縮形を渡すと、--repo を案内して止める', async ({ argv }) => {
    const result = await runCommand({ argv, remote: false })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: the short form \'N\' needs a base_repo: pass --repo <owner/repo> or use the full form \'owner/repo/N\'\n')
    expect(result.requests).toEqual([])
  })
})
