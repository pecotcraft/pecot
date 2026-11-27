/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_COMMENT_TOOLS } from '../../src/commands/issue-comment.js'
import { templateFile } from '../../src/infra/template-store.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { COMMENT_URL, commentFileContent, failedPost, linkedRepositories, MERGE_DIFF_BODY, postedComment, setUpCommentProject, updatedComment } from '../_helpers/issue-comment-case.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const POSTED_BODY = MERGE_DIFF_BODY.trim()

async function comment(arguments_: Readonly<Record<string, unknown>> = {}): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess('issue_comment', arguments_, ISSUE_COMMENT_TOOLS)
}

async function commentTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_COMMENT_TOOLS, 'issue_comment', argumentsOfTool)
}

describe('issue_comment', () => {
  it('ファイルを渡すと、フロントマターの issue_ref の Issue にコメントを投稿する', async () => {
    await explains('`issue_comment` の基本の動作のテストです。ファイルを渡した場合に、フロントマターの `issue_ref` が指す Issue にコメントを投稿し、コメントの URL を標準出力に出力することを確認します。')
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment({ file: file })

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } },
    ])
  })

  it('message に issue_ref とテンプレの種類を渡すと、その Issue にコメントを投稿する', async () => {
    await explains('`issue_comment` の `message` のテストです。`message` に `issue_ref` とテンプレートの種類を渡した場合に、指定した Issue にコメントを投稿することを確認します。')
    setUpProject()
    const github = await startGithub([postedComment(COMMENT_URL)])

    const result = await comment({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: MERGE_DIFF_BODY } }])
  })

  it.for([
    { name: 'issues の URL', url: 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456' },
    { name: 'pull の URL', url: 'https://ghes.example.com/acme/demo/pull/7#issuecomment-456' },
  ])('comment_url を持つファイルを渡すと、新しいコメントを投稿せずにそのコメントを書き換える（$name）', async ({ url }) => {
    await explains('`comment_url` を持つファイルを扱う、`issue_comment` のテストです。`issues` と `pull` のどちらの URL の場合も、新しいコメントを投稿せず、そのコメントを書き換えて `updated` の行を出力することを確認します。')
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([linkedRepositories(), updatedComment(456, url)])

    const result = await comment({ file: file })

    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: 'updated: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'PATCH', path: '/repos/acme/demo/issues/comments/456', body: { body: POSTED_BODY } },
    ])
  })

  it('書き換えの応答に URL が無いと、comment_url の URL を出す', async () => {
    await explains('`comment_url` を持つファイルを扱う、`issue_comment` のテストです。書き換えの応答が URL を含まない場合に、`comment_url` の URL を標準出力へ出力することを確認します。')
    const url = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456'
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    await startGithub([linkedRepositories(), { match: { method: 'PATCH', path: '/repos/acme/demo/issues/comments/456' }, respond: { status: 200, body: { id: 456 } }, times: 1 }])

    const result = await comment({ file: file })

    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: 'updated: comment on acme/demo/7\n' })
  })

  it('ファイルからコメントを投稿すると、できたコメントの URL をファイルの comment_url に書き戻す', async () => {
    await explains('`issue_comment` の `comment_url` の書き戻しのテストです。ファイルからコメントを投稿した場合に、できたコメントの URL をファイルの `comment_url` に書き戻すことを確認します。')
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    await comment({ file: file })

    expect(readFileSync(file, 'utf8')).toBe(commentFileContent({ extra: [`comment_url: "${COMMENT_URL}"`] }))
  })

  it('ファイルと message を一緒に渡すと、message の本文を使わずにファイルを投稿する', async () => {
    await explains('`issue_comment` の引数のテストです。ファイルと `message` を両方渡した場合は、`message` の本文を使わず、ファイルの内容を投稿することを確認します。')
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment({ file: file, message: '## 別の本文', issue_ref: 'acme/demo/999' })

    expect(result.code).toBe(0)
    expect(github.requests()).toMatchObject([{ type: 'graphql' }, { type: 'rest', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } }])
  })

  it('ファイルの Issue のリポジトリがプロジェクトに無いとき、warning の行を標準エラーに出して投稿を続ける', async () => {
    await explains('`issue_comment` のプロジェクトの登録のテストです。ファイルの Issue のリポジトリがプロジェクトに登録されていない場合に、warning の行を標準エラーに出力し、投稿は続けることを確認します。')
    const { root } = setUpProject({ repositories: ['demo', 'other'], files: { 'note.md': commentFileContent({ issueRef: 'acme/other/7' }) } })
    const file = path.join(root, 'note.md')
    const github = await startGithub([
      linkedRepositories(),
      { match: { method: 'POST', path: '/repos/acme/other/issues/7/comments' }, respond: { status: 201, body: { html_url: COMMENT_URL } }, times: 1 },
    ])

    const result = await comment({ file: file })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: acme/other is not in the project\ncreated: comment on acme/other/7\n')
    expect(github.requests()).toHaveLength(2)
  })

  it('comment_url を書き戻せないとき、warning の行を標準エラーに出して終了コード 0 で終わる', async () => {
    await explains('`issue_comment` の `comment_url` の書き戻しのテストです。ファイルを書き込めない場合に、warning の行を標準エラーに出力し、終了コード 0 で終わることを確認します。')
    const { file } = setUpCommentProject()
    chmodSync(file, 0o444)
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment({ file: file })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${COMMENT_URL}\n`)
    expect(result.stderr).toBe(`created: comment on acme/demo/7\nwarning: could not write comment_url back to the file: [Errno 13] Permission denied: '${file}'\n`)
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの本文がテンプレに合わないとき、違反の種類ごとの行を標準エラーに出し、投稿せずに終了コード 3 で終わる', async () => {
    await explains('`issue_comment` の本文の検証のテストです。ファイルの本文がテンプレートと合わない場合に、違反の種類ごとの行を標準エラーへ出力し、投稿せず終了コード 3 で終わることを確認します。')
    const { file } = setUpCommentProject({ body: '## 進捗\n\n- 見出しなし\n- ✅ 完了\n' })
    const github = await startGithub([])

    const result = await comment({ file: file })

    const lines = result.stderr.split('\n')
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(lines[0]).toBe(`error: the body does not follow the template ${templateFile('comment', 'merge-diff')}`)
    expect(lines).toContain('  missing sections: ## Merge — <summary>, ### Variance — <summary>, ### Impact — <summary>')
    expect(lines).toContain('  unusable notation: emoji are not allowed')
    expect(github.requests()).toEqual([])
  })

  it.for([
    { id: 'PW-ISSUE-COMMENT-17', name: '見出しの要約が規則に反する', message: MERGE_DIFF_BODY.replace('## Merge — 実装は半分まで進んだ', '## Merge — all done'), line: '  heading summary rule violations: ## Merge — ' },
    { id: 'PW-ISSUE-COMMENT-18', name: '<> の書き残しがある', message: `${MERGE_DIFF_BODY}\n- <次にやること> — 未定\n`, line: '  unusable notation: ' },
  ])('message の本文がテンプレに合わないとき、違反の行を出し、投稿せずに終了コード 3 で終わる（$name）', async ({ message, line }) => {
    await explains('`issue_comment` の `message` の本文の検証のテストです。見出しの要約の規則違反や `<>` の書き残しがある場合に、違反の行を標準エラーに出力し、投稿せずに終了コード 3 で終わることを確認します。')
    setUpProject()
    const github = await startGithub([])

    const result = await comment({ template: 'merge-diff', message: message, issue_ref: 'acme/demo/7' })

    expect(result.code).toBe(3)
    expect(result.stderr.split('\n').some(entry => entry.startsWith(line))).toBe(true)
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'message に template が無い', input: { message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' } },
  ])('テンプレの種類を渡していない（$name）とき、終了コード 1 で終わる', async ({ input }) => {
    await explains('`issue_comment` の引数の検証のテストです。`message` を渡して `template` を省略した場合に、`template` で指定するよう案内するエラーを出力して終了コード 1 で終わることを確認します。')
    setUpProject()

    const result = await comment(input)

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: specify a template with template (plan / merge-diff / review-findings / review-resolution / precede-notify)\n',
    })
  })

  it('message で issue_ref を渡していないとき、終了コード 1 で終わる', async () => {
    await explains('`issue_comment` の引数の検証のテストです。`message` を渡して `issue_ref` を省略した場合に、`issue_ref` が必要であることを示すエラーを出力して終了コード 1 で終わることを確認します。')
    setUpProject()

    const result = await comment({ template: 'merge-diff', message: MERGE_DIFF_BODY })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: issue_ref (Issue reference) is required with message\n' })
  })

  it('ファイルと message のどちらも渡していないとき、使い方を添えて終了コード 1 で終わる', async () => {
    await explains('`issue_comment` の引数の検証のテストです。ファイルと `message` のどちらも渡さなかった場合に、使い方を添えたエラーを出力して終了コード 1 で終わることを確認します。')
    setUpProject()

    const result = await comment()

    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      'error: missing arguments\n'
      + '  direct posting: issue_comment with message: <MESSAGE>, template: <template>, issue_ref: "owner/repo/123"\n'
      + '  from a file: issue_comment with file: <path>\n',
    )
  })

  it('ファイルのフロントマターを読めないとき、終了コード 1 で終わる', async () => {
    await explains('`issue_comment` のファイルの検証のテストです。フロントマターを読み取れない場合に、`frontmatter not found` のエラーを出力して終了コード 1 で終わることを確認します。')
    const project = setUpProject({ files: { 'note.md': '本文だけで、フロントマターが無い\n' } })
    const file = path.join(project.root, 'note.md')

    const result = await comment({ file: file })

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: frontmatter not found (does not start with ---)\n' })
  })

  it('ファイルのフロントマターに template が無いとき、終了コード 1 で終わる', async () => {
    await explains('`issue_comment` のファイルの検証のテストです。フロントマターが `template` を含まない場合に、指定を求めるエラーを出力して終了コード 1 で終わることを確認します。')
    const { file } = setUpCommentProject({ withoutTemplate: true })

    const result = await comment({ file: file })

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: specify template in the frontmatter (plan / merge-diff / review-findings / review-resolution / precede-notify)\n',
    })
  })

  it.for([
    { name: 'URL の形が誤っている', url: 'https://ghes.example.com/acme/demo/issues/7', message: 'comment_url has the wrong form: https://ghes.example.com/acme/demo/issues/7\nexpected: https://<host>/<owner>/<repo>/{issues|pull}/<number>#issuecomment-<id>' },
    { name: 'ホストが設定と違う', url: 'https://github.com/acme/demo/issues/7#issuecomment-1', message: 'the host of comment_url (github.com) differs from the configured host (ghes.example.com)' },
    { name: 'リポジトリが違う', url: 'https://ghes.example.com/acme/other/issues/7#issuecomment-1', message: 'comment_url (acme/other/7) points to a different Issue than issue_ref (acme/demo/7)' },
    { name: '番号が違う', url: 'https://ghes.example.com/acme/demo/pull/8#issuecomment-1', message: 'comment_url (acme/demo/8) points to a different Issue than issue_ref (acme/demo/7)' },
  ])('comment_url が誤っているとき、API を呼ばずに終了コード 1 で終わる（$name）', async ({ url, message }) => {
    await explains('`comment_url` の検証のテストです。URL の形やホストが誤っている場合や、`issue_ref` と異なる Issue を指す場合に、API を呼ばずにエラーを出力して終了コード 1 で終わることを確認します。')
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([])

    const result = await comment({ file: file })

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: ${message.replaceAll('\n', '\n  ')}\n` })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'ファイルを渡した', input: (file: string): Readonly<Record<string, unknown>> => ({ file: file }) },
    { name: 'message を渡した', input: (): Readonly<Record<string, unknown>> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }) },
  ])('対象のリポを含む設定が 2 つあり .active も選べない（$name）とき、候補と project の案内を出して終了コード 1 で終わる', async ({ input }) => {
    await explains('`issue_comment` のプロジェクトの設定の選択のテスト（ファイルを渡す場合と `message` を渡す場合）です。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、候補と `project` の案内を出力して終了コード 1 で終わることを確認します。')
    const { file, ...project } = setUpCommentProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await comment(input(file))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'ファイルを渡した', input: (file: string): Readonly<Record<string, unknown>> => ({ file: file }) },
    { name: 'message を渡した', input: (): Readonly<Record<string, unknown>> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }) },
  ])('対象のリポを含む設定が無い（$name）とき、error を出して終了コード 1 で終わる', async ({ input }) => {
    await explains('`issue_comment` のプロジェクトの設定の選択のテスト（ファイルを渡す場合と `message` を渡す場合）です。対象のリポジトリを含む設定が存在しない場合に、エラーと選べる設定の一覧を出力して終了コード 1 で終わることを確認します。')
    const repository = enterGitRepository({ 'note.md': commentFileContent() })
    setUpProject({ repositories: ['other'] })

    const result = await comment(input(path.join(repository, 'note.md')))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で message の投稿をする', async () => {
    await explains('`issue_comment` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定で `message` の本文を投稿することを確認します。')
    makeAmbiguous(setUpProject())
    await startGithub([postedComment(COMMENT_URL)])

    const result = await comment({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7', project: SECOND_PROJECT })

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定でファイルの投稿をする', async () => {
    await explains('`issue_comment` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定でファイルを投稿することを確認します。')
    const { file, ...project } = setUpCommentProject()
    makeAmbiguous(project)
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment({ file: file, project: SECOND_PROJECT })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${COMMENT_URL}\n`)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で message の投稿をする', async () => {
    await explains('`issue_comment` のプロジェクトの設定の選択のテストです。`.active` が存在しなくても、対象のリポジトリを含む設定が 1 つであれば、その設定で `message` の本文を投稿することを確認します。')
    removeActive(setUpProject())
    await startGithub([postedComment(COMMENT_URL)])

    const result = await comment({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
  })

  it.for([{ status: 500 }, { status: 404 }])('ファイルの投稿で GitHub API が HTTP $status を返したとき、終了コード 1 で終わる', async ({ status }) => {
    await explains('`issue_comment` の GitHub API のエラーのテストです。ファイルの投稿で HTTP 500 か 404 が返った場合に、`could not create a comment` で始まるエラーを出力して終了コード 1 で終わることを確認します。')
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), failedPost(status)])

    const result = await comment({ file: file })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの書き換えと message の投稿で GitHub API がエラーを返したとき、終了コード 1 で終わる', async () => {
    await explains('`issue_comment` の GitHub API のエラーのテストです。ファイルの書き換えと `message` の投稿でエラーが返った場合に、どちらも終了コード 1 で終わり、`could not` で始まるエラーを出力することを確認します。')
    const url = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456'
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    await startGithub([
      linkedRepositories(),
      { match: { method: 'PATCH', path: '/repos/acme/demo/issues/comments/456' }, respond: { status: 500, body: { message: 'failure' } }, times: 1 },
      failedPost(500),
    ])

    const updated = await comment({ file: file })
    const direct = await comment({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

    expect(updated.code).toBe(1)
    expect(updated.stderr).toContain('error: could not update the comment on Issue acme/demo/7: ')
    expect(direct.code).toBe(1)
    expect(direct.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
  })

  it.for([
    { name: 'ファイルの issue_ref', input: (file: string): Readonly<Record<string, unknown>> => ({ file: file }), issueRef: 'invalid-format' },
    { name: 'issue_ref', input: (): Readonly<Record<string, unknown>> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'invalid-format' }), issueRef: 'acme/demo/7' },
  ])('Issue の参照の形が誤っている（$name）とき、終了コード 2 で終わる', async ({ input, issueRef }) => {
    await explains('`issue_comment` の Issue の参照の検証のテストです。ファイルの `issue_ref` か `issue_ref` の形が誤っている場合に、GitHub へ何も要求せず、終了コード 2 で終わることを確認します。')
    const { file } = setUpCommentProject({ issueRef })
    const github = await startGithub([])

    const result = await comment(input(file))

    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr: 'error: invalid reference: invalid-format\n  accepted forms:\n    - full: \'owner/repo/N\'\n    - short: \'N\' (with a base repository)\n',
    })
    expect(github.requests()).toEqual([])
  })

  describe('MCP の data', () => {
    it('ファイルから投稿すると、コメントの URL・created・comment_url を書き戻したファイルのパスを返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-03')
      await verifies(context, 'PW-ISSUE-COMMENT-06')
      await verifies(context, 'PW-ISSUE-COMMENT-10')
      await verifies(context, 'PW-ISSUE-COMMENT-12')
      await explains('MCP ツール `issue_comment` の結果のテストです。ファイルから投稿した場合に、コメントの URL・`created`・`comment_url` を書き戻したファイルのパスを返すことを確認します。')
      const { file } = setUpCommentProject()
      const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

      const outcome = await commentTool({ file })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', change: 'created', commentUrl: COMMENT_URL, file: path.resolve(file) })
      expect(github.requests()).toMatchObject([
        { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
        { type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } },
      ])
      expect(readFileSync(file, 'utf8')).toBe(commentFileContent({ extra: [`comment_url: "${COMMENT_URL}"`] }))
    })

    it('comment_url を書き戻せないと、file を返さず、warning を warnings に返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-15')
      await explains('MCP ツール `issue_comment` の `comment_url` の書き戻しのテストです。ファイルを書き込めない場合に、`file` を返さず、warning を `warnings` に返すことを確認します。')
      const { file } = setUpCommentProject()
      chmodSync(file, 0o444)
      await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

      const outcome = await commentTool({ file })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        issue: 'acme/demo/7',
        change: 'created',
        commentUrl: COMMENT_URL,
        warnings: [`could not write comment_url back to the file: [Errno 13] Permission denied: '${file}'`],
      })
    })

    it.for([
      { name: 'issues の URL', url: 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456' },
      { name: 'pull の URL', url: 'https://ghes.example.com/acme/demo/pull/7#issuecomment-456' },
    ])('comment_url を持つファイルを渡すと、新しく投稿せずにそのコメントを書き換え、updated と URL を返す（$name）', async ({ url }, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-05')
      await verifies(context, 'PW-ISSUE-COMMENT-11')
      await verifies(context, 'PW-ISSUE-COMMENT-13')
      await explains('MCP ツール `issue_comment` の書き換えのテストです。`comment_url` を持つファイルを渡した場合に、新しく投稿せずそのコメントを書き換え、`updated` と URL を返すことを確認します。')
      const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
      const github = await startGithub([linkedRepositories(), updatedComment(456, url)])

      const outcome = await commentTool({ file })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', change: 'updated', commentUrl: url })
      expect(github.requests()).toMatchObject([
        { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
        { type: 'rest', method: 'PATCH', path: '/repos/acme/demo/issues/comments/456', body: { body: POSTED_BODY } },
      ])
    })

    it('ファイルの本文がテンプレに合わないと、違反の文を detail に入れて content-invalid を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-16')
      await verifies(context, 'PW-ISSUE-COMMENT-17')
      await verifies(context, 'PW-ISSUE-COMMENT-18')
      await explains('MCP ツール `issue_comment` の本文の検証のテストです。ファイルの本文がテンプレートと合わない場合に、違反の文を `detail` へ入れ、`kind` が `content-invalid` の失敗を返すことを確認します。')
      const { file } = setUpCommentProject({ body: '## 進捗\n\n- 見出しなし\n- ✅ 完了\n' })
      const github = await startGithub([])

      const outcome = await commentTool({ file })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'content-invalid' } })
      expect(outcome.structured).toEqual({
        kind: 'content-invalid',
        detail: [
          `the body does not follow the template ${templateFile('comment', 'merge-diff')}`,
          '  missing sections: ## Merge — <summary>, ### Variance — <summary>, ### Impact — <summary>',
          '  unusable notation: emoji are not allowed',
        ].join('\n'),
      })
      expect(github.requests()).toEqual([])
    })

    it('message に issue_ref とテンプレの種類を渡すと、その Issue にコメントを投稿し、URL と created を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-04')
      await verifies(context, 'PW-ISSUE-COMMENT-10')
      await verifies(context, 'PW-ISSUE-COMMENT-12')
      await explains('MCP ツール `issue_comment` の投稿のテストです。`message` に `issue_ref` とテンプレートの種類を渡した場合に、その Issue にコメントを投稿し、URL と `created` を返すことを確認します。')
      setUpProject()
      const github = await startGithub([postedComment(COMMENT_URL)])

      const outcome = await commentTool({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', change: 'created', commentUrl: COMMENT_URL })
      expect(github.requests()).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: MERGE_DIFF_BODY } }])
    })

    it('file と message を一緒に渡すと、message の本文を使わずにファイルを投稿する', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-08')
      await explains('MCP ツール `issue_comment` の引数のテストです。`file` と `message` を両方渡した場合は、`message` の本文を使わず、ファイルの内容を投稿することを確認します。')
      const { file } = setUpCommentProject()
      const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

      const outcome = await commentTool({ file, message: '## 別の本文', issue_ref: 'acme/demo/999' })

      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', change: 'created' })
      expect(github.requests()).toMatchObject([{ type: 'graphql' }, { type: 'rest', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } }])
    })

    it('ファイルの Issue のリポジトリがプロジェクトに無いとき、warnings に入れて投稿を続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-14')
      await explains('MCP ツール `issue_comment` のプロジェクトの登録のテストです。ファイルの Issue のリポジトリがプロジェクトに登録されていない場合に、`warnings` に理由を入れ、投稿は続けることを確認します。')
      const { root } = setUpProject({ repositories: ['demo', 'other'], files: { 'note.md': commentFileContent({ issueRef: 'acme/other/7' }) } })
      const file = path.join(root, 'note.md')
      await startGithub([
        linkedRepositories(),
        { match: { method: 'POST', path: '/repos/acme/other/issues/7/comments' }, respond: { status: 201, body: { html_url: COMMENT_URL } }, times: 1 },
      ])

      const outcome = await commentTool({ file })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/other/7', change: 'created', warnings: ['acme/other is not in the project'] })
    })

    it.for([
      { id: 'PW-ISSUE-COMMENT-17', name: '見出しの要約が規則に反する', message: MERGE_DIFF_BODY.replace('## Merge — 実装は半分まで進んだ', '## Merge — all done'), line: '  heading summary rule violations: ## Merge — ' },
      { id: 'PW-ISSUE-COMMENT-18', name: '<> の書き残しがある', message: `${MERGE_DIFF_BODY}\n- <次にやること> — 未定\n`, line: '  unusable notation: ' },
    ])('message の本文がテンプレに合わないとき、違反の行を detail に入れ、投稿せずに content-invalid を返す（$name）', async ({ id, message, line }, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-16')
      await verifies(context, id)
      await explains('MCP ツール `issue_comment` の本文の検証のテストです。`message` の本文がテンプレートと合わない場合に、違反の行を `detail` へ入れ、投稿せず `kind` が `content-invalid` の失敗を返すことを確認します。')
      setUpProject()
      const github = await startGithub([])

      const outcome = await commentTool({ template: 'merge-diff', message, issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('content-invalid')
      expect(String(outcome.structured['detail']).split('\n').some(entry => entry.startsWith(line))).toBe(true)
      expect(github.requests()).toEqual([])
    })

    it('message でテンプレの種類を渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-19')
      await explains('MCP ツール `issue_comment` の引数の検証のテストです。`message` を渡してテンプレートの種類を省略した場合に、`kind` が `invalid-input` の失敗を返すことを確認します。')
      setUpProject()

      const outcome = await commentTool({ message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'specify a template with template (plan / merge-diff / review-findings / review-resolution / precede-notify)' })
    })

    it('message で issue_ref を渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-20')
      await explains('MCP ツール `issue_comment` の引数の検証のテストです。`message` を渡して `issue_ref` を省略した場合に、`kind` が `invalid-input` の失敗を返すことを確認します。')
      setUpProject()

      const outcome = await commentTool({ template: 'merge-diff', message: MERGE_DIFF_BODY })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'issue_ref (Issue reference) is required with message' })
    })

    it('file と message のどちらも渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-21')
      await explains('MCP ツール `issue_comment` の引数の検証のテストです。`file` と `message` のどちらも渡さなかった場合に、`kind` が `invalid-input` の失敗を返し、`detail` が `missing arguments` で始まることを確認します。')
      setUpProject()

      const outcome = await commentTool({})

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toMatch(/^missing arguments\n/u)
    })

    it.for([
      { name: 'フロントマターが無い', id: 'PW-ISSUE-COMMENT-22', content: '本文だけで、フロントマターが無い\n', detail: 'frontmatter not found (does not start with ---)' },
      { name: 'フロントマターに template が無い', id: 'PW-ISSUE-COMMENT-23', content: commentFileContent({ withoutTemplate: true }), detail: 'specify template in the frontmatter (plan / merge-diff / review-findings / review-resolution / precede-notify)' },
    ])('ファイルの$name とき、kind が content-invalid の失敗を返す', async (row, context) => {
      await verifies(context, row.id)
      await explains('MCP ツール `issue_comment` のファイルの検証のテストです。フロントマターが存在しない場合と `template` が存在しない場合に、`kind` が `content-invalid` の失敗を返すことを確認します。')
      const project = setUpProject({ files: { 'note.md': row.content } })

      const outcome = await commentTool({ file: path.join(project.root, 'note.md') })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'content-invalid', detail: row.detail })
    })

    it.for([
      { name: 'URL の形が誤っている', url: 'https://ghes.example.com/acme/demo/issues/7', message: 'comment_url has the wrong form: https://ghes.example.com/acme/demo/issues/7\n  expected: https://<host>/<owner>/<repo>/{issues|pull}/<number>#issuecomment-<id>' },
      { name: 'ホストが設定と違う', url: 'https://github.com/acme/demo/issues/7#issuecomment-1', message: 'the host of comment_url (github.com) differs from the configured host (ghes.example.com)' },
      { name: 'リポジトリが違う', url: 'https://ghes.example.com/acme/other/issues/7#issuecomment-1', message: 'comment_url (acme/other/7) points to a different Issue than issue_ref (acme/demo/7)' },
      { name: '番号が違う', url: 'https://ghes.example.com/acme/demo/pull/8#issuecomment-1', message: 'comment_url (acme/demo/8) points to a different Issue than issue_ref (acme/demo/7)' },
    ])('comment_url が誤っているとき、API を呼ばずに kind が invalid-input の失敗を返す（$name）', async ({ url, message }, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-24')
      await explains('MCP ツール `issue_comment` の `comment_url` の検証のテストです。URL の形やホストが誤っている場合や、`issue_ref` と異なる Issue を指す場合に、API を呼ばずに `kind` が `invalid-input` の失敗を返すことを確認します。')
      const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
      const github = await startGithub([])

      const outcome = await commentTool({ file })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: message })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'file を渡した', arguments_: (file: string): Record<string, unknown> => ({ file }) },
      { name: 'message を渡した', arguments_: (): Record<string, unknown> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }) },
    ])('対象のリポを含む設定が 2 つあり .active も選べない（$name）とき、kind が no-active-project の失敗に候補と project の案内を入れる', async (row, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-25')
      await explains('MCP ツール `issue_comment` のプロジェクトの設定の選択のテスト（`file` を渡す場合と `message` を渡す場合）です。対象のリポジトリを含む設定が 2 つあり `.active` でも選べない場合に、`kind` が `no-active-project` の失敗を返し、`detail` に候補と案内を入れることを確認します。')
      const { file, ...project } = setUpCommentProject()
      makeAmbiguous(project)
      const github = await startGithub([])

      const outcome = await commentTool(row.arguments_(file))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'no-active-project', detail: 'acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second' })
      expect(github.requests()).toEqual([])
    })

    it.for([
      { name: 'file を渡した', arguments_: (file: string): Record<string, unknown> => ({ file }) },
      { name: 'message を渡した', arguments_: (): Record<string, unknown> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }) },
    ])('対象のリポを含む設定が無い（$name）とき、kind が repo-not-in-project の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-31')
      await explains('MCP ツール `issue_comment` のプロジェクトの設定の選択のテスト（`file` を渡す場合と `message` を渡す場合）です。対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      const repository = enterGitRepository({ 'note.md': commentFileContent() })
      setUpProject({ repositories: ['other'] })

      const outcome = await commentTool(row.arguments_(path.join(repository, 'note.md')))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme' })
    })

    it.for([
      { name: 'message', arguments_: (): Record<string, unknown> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }), rules: (): ResponseRule[] => [postedComment(COMMENT_URL)] },
      { name: 'file', arguments_: (file: string): Record<string, unknown> => ({ file }), rules: (): ResponseRule[] => [linkedRepositories(), postedComment(COMMENT_URL)] },
    ])('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で $name の投稿をする', async (row, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-32')
      await explains('MCP ツール `issue_comment` の `project` のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で指定した設定で `message` か `file` を投稿することを確認します。')
      const { file, ...project } = setUpCommentProject()
      makeAmbiguous(project)
      await startGithub(row.rules())

      const outcome = await commentTool({ ...row.arguments_(file), project: SECOND_PROJECT })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', change: 'created', commentUrl: COMMENT_URL })
    })

    it.for([
      { name: 'ファイルの投稿で HTTP 500 が返った', rules: (): ResponseRule[] => [linkedRepositories(), failedPost(500)], arguments_: (file: string): Record<string, unknown> => ({ file }), kind: 'github-api', detail: 'could not create a comment on Issue acme/demo/7: ' },
      { name: 'ファイルの投稿で HTTP 404 が返った', rules: (): ResponseRule[] => [linkedRepositories(), failedPost(404)], arguments_: (file: string): Record<string, unknown> => ({ file }), kind: 'github-not-found', detail: 'could not create a comment on Issue acme/demo/7: ' },
      { name: 'message の投稿で HTTP 500 が返った', rules: (): ResponseRule[] => [failedPost(500)], arguments_: (): Record<string, unknown> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' }), kind: 'github-api', detail: 'could not create a comment on Issue acme/demo/7: ' },
    ])('$name とき、失敗を返し、ファイルを書き換えない', async (row, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-26')
      await explains('MCP ツール `issue_comment` の GitHub API のエラーのテストです。投稿が失敗した場合に、失敗を返してファイルは書き換えず、HTTP 404 の `kind` は `github-not-found`、それ以外の `kind` は `github-api` になることを確認します。')
      const { file } = setUpCommentProject()
      await startGithub(row.rules())

      const outcome = await commentTool(row.arguments_(file))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe(row.kind)
      expect(String(outcome.structured['detail'])).toContain(row.detail)
      expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
    })

    it('コメントの書き換えで GitHub API がエラーを返したとき、失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-26')
      await explains('MCP ツール `issue_comment` の GitHub API のエラーのテストです。コメントの書き換えが失敗した場合に、`could not update the comment` で始まる理由を `detail` に入れた失敗を返すことを確認します。')
      const url = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456'
      const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
      await startGithub([linkedRepositories(), { match: { method: 'PATCH', path: '/repos/acme/demo/issues/comments/456' }, respond: { status: 500, body: { message: 'failure' } }, times: 1 }])

      const outcome = await commentTool({ file })

      expect(outcome.isError).toBe(true)
      expect(String(outcome.structured['detail'])).toContain('could not update the comment on Issue acme/demo/7: ')
    })

    it.for([
      { name: 'ファイルの issue_ref', arguments_: (file: string): Record<string, unknown> => ({ file }), issueRef: 'invalid-format' },
      { name: '引数の issue_ref', arguments_: (): Record<string, unknown> => ({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'invalid-format' }), issueRef: 'acme/demo/7' },
    ])('Issue の参照の形が誤っている（$name）とき、kind が invalid-input の失敗を返す', async (row, context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-27')
      await explains('MCP ツール `issue_comment` の Issue の参照の検証のテストです。ファイルの `issue_ref` か引数の `issue_ref` の形が誤っている場合に、`kind` が `invalid-input` の失敗を返し、GitHub へは要求しないことを確認します。')
      const { file } = setUpCommentProject({ issueRef: row.issueRef })
      const github = await startGithub([])

      const outcome = await commentTool(row.arguments_(file))

      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('invalid-input')
      expect(outcome.structured['detail']).toMatch(/^invalid reference: invalid-format\n/u)
      expect(github.requests()).toEqual([])
    })
  })
})
