/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_COMMENT_COMMANDS } from '../../src/commands/issue-comment.js'
import { templateFile } from '../../src/infra/template-store.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { COMMENT_URL, commentFileContent, failedPost, linkedRepositories, MERGE_DIFF_BODY, postedComment, setUpCommentProject, updatedComment } from '../_helpers/issue-comment-case.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../fake-github/server.js'
import { makeAmbiguous, removeActive, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const POSTED_BODY = MERGE_DIFF_BODY.trim()

async function comment(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'comment', ...argv], ISSUE_COMMENT_COMMANDS)
}

async function commentTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_COMMENT_COMMANDS, 'issue_comment', argumentsOfTool)
}

describe('issue comment', () => {
  it('ファイルを渡すと、フロントマターの issue_ref の Issue にコメントを投稿する', async () => {
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file)

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } },
    ])
  })

  it('-m に --issue-ref とテンプレの種類を渡すと、その Issue にコメントを投稿する', async () => {
    setUpProject()
    const github = await startGithub([postedComment(COMMENT_URL)])

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: MERGE_DIFF_BODY } }])
  })

  it.for([
    { name: 'issues の URL', url: 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456' },
    { name: 'pull の URL', url: 'https://ghes.example.com/acme/demo/pull/7#issuecomment-456' },
  ])('comment_url を持つファイルを渡すと、新しいコメントを投稿せずにそのコメントを書き換える（$name）', async ({ url }) => {
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([linkedRepositories(), updatedComment(456, url)])

    const result = await comment(file)

    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: 'updated: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'PATCH', path: '/repos/acme/demo/issues/comments/456', body: { body: POSTED_BODY } },
    ])
  })

  it('ファイルからコメントを投稿すると、できたコメントの URL をファイルの comment_url に書き戻す', async () => {
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    await comment(file)

    expect(readFileSync(file, 'utf8')).toBe(commentFileContent({ extra: [`comment_url: "${COMMENT_URL}"`] }))
  })

  it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルを投稿する', async () => {
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file, '-m', '## 別の本文', '--issue-ref', 'acme/demo/999')

    expect(result.code).toBe(0)
    expect(github.requests()).toMatchObject([{ type: 'graphql' }, { type: 'rest', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } }])
  })

  it('ファイルの Issue のリポジトリがプロジェクトに無いとき、warning の行を標準エラーに出して投稿を続ける', async () => {
    const { root } = setUpProject({ repositories: ['demo', 'other'], files: { 'note.md': commentFileContent({ issueRef: 'acme/other/7' }) } })
    const file = path.join(root, 'note.md')
    const github = await startGithub([
      linkedRepositories(),
      { match: { method: 'POST', path: '/repos/acme/other/issues/7/comments' }, respond: { status: 201, body: { html_url: COMMENT_URL } }, times: 1 },
    ])

    const result = await comment(file)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: acme/other is not in the project\ncreated: comment on acme/other/7\n')
    expect(github.requests()).toHaveLength(2)
  })

  it('comment_url を書き戻せないとき、warning の行を標準エラーに出して終了コード 0 で終わる', async () => {
    const { file } = setUpCommentProject()
    chmodSync(file, 0o444)
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${COMMENT_URL}\n`)
    expect(result.stderr).toBe(`created: comment on acme/demo/7\nwarning: could not write comment_url back to the file: [Errno 13] Permission denied: '${file}'\n`)
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの本文がテンプレに合わないとき、違反の種類ごとの行を標準エラーに出し、投稿せずに終了コード 3 で終わる', async () => {
    const { file } = setUpCommentProject({ body: '## 進捗\n\n- 見出しなし\n- ✅ 完了\n' })
    const github = await startGithub([])

    const result = await comment(file)

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
  ])('-m の本文がテンプレに合わないとき、違反の行を出し、投稿せずに終了コード 3 で終わる（$name）', async ({ message, line }) => {
    setUpProject()
    const github = await startGithub([])

    const result = await comment('-t', 'merge-diff', '-m', message, '--issue-ref', 'acme/demo/7')

    expect(result.code).toBe(3)
    expect(result.stderr.split('\n').some(entry => entry.startsWith(line))).toBe(true)
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: '-m に -t が無い', argv: ['-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7'] },
  ])('テンプレの種類を渡していない（$name）とき、終了コード 1 で終わる', async ({ argv }) => {
    setUpProject()

    const result = await comment(...argv)

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: specify a template with --template (plan / merge-diff / review-findings / review-resolution / precede-notify)\n',
    })
  })

  it('-m で --issue-ref を渡していないとき、終了コード 1 で終わる', async () => {
    setUpProject()

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY)

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --issue-ref (Issue reference) is required with --message\n' })
  })

  it('ファイルと -m のどちらも渡していないとき、使い方を添えて終了コード 1 で終わる', async () => {
    setUpProject()

    const result = await comment()

    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      'error: missing arguments\n'
      + '  direct posting: pecot issue comment --message <MESSAGE> --template <template> --issue-ref owner/repo/123\n'
      + '  from a file: pecot issue comment <path>\n',
    )
  })

  it('ファイルのフロントマターを読めないとき、終了コード 1 で終わる', async () => {
    const project = setUpProject({ files: { 'note.md': '本文だけで、フロントマターが無い\n' } })
    const file = path.join(project.root, 'note.md')

    const result = await comment(file)

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: frontmatter not found (does not start with ---)\n' })
  })

  it('ファイルのフロントマターに template が無いとき、終了コード 1 で終わる', async () => {
    const { file } = setUpCommentProject({ withoutTemplate: true })

    const result = await comment(file)

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
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([])

    const result = await comment(file)

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: ${message.replaceAll('\n', '\n  ')}\n` })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'ファイルを渡した', argv: (file: string): string[] => [file] },
    { name: '-m を渡した', argv: (): string[] => ['-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7'] },
  ])('対象のリポを含む設定が 2 つあり .active も選べない（$name）とき、候補と --project の案内を出して終了コード 1 で終わる', async ({ argv }) => {
    const { file, ...project } = setUpCommentProject()
    makeAmbiguous(project)
    const github = await startGithub([])

    const result = await comment(...argv(file))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ghes.example.com_acme_board_acme, second\n' })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'ファイルを渡した', argv: (file: string): string[] => [file] },
    { name: '-m を渡した', argv: (): string[] => ['-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7'] },
  ])('対象のリポを含む設定が無い（$name）とき、error を出して終了コード 1 で終わる', async ({ argv }) => {
    const repository = enterGitRepository({ 'note.md': commentFileContent() })
    setUpProject({ repositories: ['other'] })

    const result = await comment(...argv(path.join(repository, 'note.md')))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で -m の投稿をする', async () => {
    makeAmbiguous(setUpProject())
    await startGithub([postedComment(COMMENT_URL)])

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7', '--project', SECOND_PROJECT)

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定でファイルの投稿をする', async () => {
    const { file, ...project } = setUpCommentProject()
    makeAmbiguous(project)
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file, '--project', SECOND_PROJECT)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${COMMENT_URL}\n`)
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で -m の投稿をする', async () => {
    removeActive(setUpProject())
    await startGithub([postedComment(COMMENT_URL)])

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
  })

  it.for([{ status: 500 }, { status: 404 }])('ファイルの投稿で GitHub API が HTTP $status を返したとき、終了コード 1 で終わる', async ({ status }) => {
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), failedPost(status)])

    const result = await comment(file)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの書き換えと -m の投稿で GitHub API がエラーを返したとき、終了コード 1 で終わる', async () => {
    const url = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456'
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    await startGithub([
      linkedRepositories(),
      { match: { method: 'PATCH', path: '/repos/acme/demo/issues/comments/456' }, respond: { status: 500, body: { message: 'failure' } }, times: 1 },
      failedPost(500),
    ])

    const updated = await comment(file)
    const direct = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'acme/demo/7')

    expect(updated.code).toBe(1)
    expect(updated.stderr).toContain('error: could not update the comment on Issue acme/demo/7: ')
    expect(direct.code).toBe(1)
    expect(direct.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
  })

  it.for([
    { name: 'ファイルの issue_ref', argv: (file: string): string[] => [file], issueRef: 'invalid-format' },
    { name: '--issue-ref', argv: (): string[] => ['-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue-ref', 'invalid-format'], issueRef: 'acme/demo/7' },
  ])('Issue の参照の形が誤っている（$name）とき、終了コード 2 で終わる', async ({ argv, issueRef }) => {
    const { file } = setUpCommentProject({ issueRef })
    const github = await startGithub([])

    const result = await comment(...argv(file))

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
      setUpProject()
      const github = await startGithub([postedComment(COMMENT_URL)])

      const outcome = await commentTool({ template: 'merge-diff', message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

      expect(outcome.structured).toEqual({ issue: 'acme/demo/7', change: 'created', commentUrl: COMMENT_URL })
      expect(github.requests()).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: MERGE_DIFF_BODY } }])
    })

    it('file と message を一緒に渡すと、message の本文を使わずにファイルを投稿する', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-08')
      const { file } = setUpCommentProject()
      const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

      const outcome = await commentTool({ file, message: '## 別の本文', issue_ref: 'acme/demo/999' })

      expect(outcome.structured).toMatchObject({ issue: 'acme/demo/7', change: 'created' })
      expect(github.requests()).toMatchObject([{ type: 'graphql' }, { type: 'rest', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } }])
    })

    it('ファイルの Issue のリポジトリがプロジェクトに無いとき、warnings に入れて投稿を続ける', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-14')
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
      setUpProject()

      const outcome = await commentTool({ message: MERGE_DIFF_BODY, issue_ref: 'acme/demo/7' })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'specify a template with template (plan / merge-diff / review-findings / review-resolution / precede-notify)' })
    })

    it('message で issue_ref を渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-20')
      setUpProject()

      const outcome = await commentTool({ template: 'merge-diff', message: MERGE_DIFF_BODY })

      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toEqual({ kind: 'invalid-input', detail: 'issue_ref (Issue reference) is required with message' })
    })

    it('file と message のどちらも渡していないとき、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-COMMENT-21')
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
