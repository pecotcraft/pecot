// 入力の誤りの文が、ツールの入力名で案内すること
import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { runTool } from '../../../tests/_helpers/command-harness.js'

useIsolatedEnvironment()

describe('入力の誤りの文の入力名', () => {
  it.for([
    { name: 'pr_create の message に title と base が無い', tool: 'pr_create', input: { message: 'body' }, expected: 'title and base (base branch) are required with message' },
    { name: 'project_link の package と changelog_file', tool: 'project_link', input: { repo: 'acme/other', package: ['a:b'], changelog_file: 'c' }, expected: 'package and changelog_file cannot be used together' },
    { name: 'project_link の package に区切りが無い', tool: 'project_link', input: { repo: 'acme/other', package: ['bad'] }, expected: 'give package: <NAME:PATH>: \'bad\'' },
  ])('$name とき、入力名で案内して止める', async ({ tool, input, expected }) => {
    await explains('入力の誤りを表示する、失敗の文のテストです。`pr_create` や `project_link` に誤った入力を渡した場合に、失敗の `detail` で入力名を使って案内し、API を呼ばないことを確認します。')
    const result = await runTool({ tool, arguments: input })
    expect(result.isError).toBe(true)
    expect(result.structured['detail']).toBe(expected)
    expect(result.requests).toEqual([])
  })

  it.for([
    { name: 'pr_show', tool: 'pr_show', input: { pr_ref: '7' } },
  ])('git の外で $name に短縮形を渡すと、repo を案内して止める', async ({ tool, input }) => {
    await explains('git リポジトリの外で、Issue や PR の番号だけを指定した場合のテストです。`pr_show` に短縮形の `7` を渡した場合に、`repo` の指定を案内する失敗を返し、API を呼ばないことを確認します。')
    const result = await runTool({ tool, arguments: input, remote: false })
    expect(result.isError).toBe(true)
    expect(result.structured['detail']).toBe('the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'')
    expect(result.requests).toEqual([])
  })
})
