/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_COMMENT_COMMANDS } from '../../src/commands/issue-comment.js'
import { compareStrings } from '../../src/domain/python-format.js'
import { templateFile } from '../../src/infra/template-store.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { COMMENT_URL, commentFileContent, failedPost, linkedRepositories, MERGE_DIFF_BODY, postedComment, setUpCommentProject, updatedComment } from '../_helpers/issue-comment-case.js'
import { enterGitRepository, runInProcess, setUpProject, startGithub } from '../_helpers/interface-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const POSTED_BODY = MERGE_DIFF_BODY.trim()

async function comment(...argv: readonly string[]): Promise<Awaited<ReturnType<typeof runInProcess>>> {
  return await runInProcess(['issue', 'comment', ...argv], ISSUE_COMMENT_COMMANDS)
}

function outputFiles(root: string): string[] {
  const directory = path.join(root, '.pecot', 'tmp', 'output')
  return existsSync(directory) ? readdirSync(directory).toSorted(compareStrings) : []
}

describe('issue comment', () => {
  it('--prepare とテンプレの種類を渡すと、テンプレのコピーを .pecot/tmp/output/ に書く', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-01')
    await verifies(context, 'PW-ISSUE-COMMENT-09')
    const { root } = setUpProject()

    const result = await comment('--prepare', '-t', 'merge-diff')

    const [name = ''] = outputFiles(root)
    expect(name).toMatch(/^comment-merge-diff-\d{8}-\d{6}\.md$/u)
    const written = path.join(root, '.pecot', 'tmp', 'output', name)
    expect(result).toEqual({ code: 0, stdout: `${written}\n`, stderr: '' })
    expect(readFileSync(written, 'utf8')).toBe(readFileSync(templateFile('comment', 'merge-diff'), 'utf8'))
  })

  it('--prepare に --issue を渡すと、コピーの issue_ref に渡した参照を入れる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-02')
    const { root } = setUpProject()

    await comment('--prepare', '-t', 'plan', '--issue', 'acme/demo/123')

    const [name = ''] = outputFiles(root)
    const content = readFileSync(path.join(root, '.pecot', 'tmp', 'output', name), 'utf8')
    expect(content).toContain('issue_ref: "acme/demo/123"\n')
    expect(content).not.toContain('issue_ref: ""')
  })

  it('--prepare とファイルを一緒に渡すと、ファイルを投稿せずにテンプレのコピーだけを書く', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-07')
    const { root, file } = setUpCommentProject()
    const github = await startGithub([])

    const result = await comment('--prepare', '-t', 'merge-diff', file)

    expect(result.code).toBe(0)
    expect(outputFiles(root)).toHaveLength(1)
    expect(github.requests()).toEqual([])
  })

  it('ファイルを渡すと、フロントマターの issue_ref の Issue にコメントを投稿する', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-03')
    await verifies(context, 'PW-ISSUE-COMMENT-10')
    await verifies(context, 'PW-ISSUE-COMMENT-12')
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file)

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } },
    ])
  })

  it('-m に --issue とテンプレの種類を渡すと、その Issue にコメントを投稿する', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-04')
    await verifies(context, 'PW-ISSUE-COMMENT-10')
    await verifies(context, 'PW-ISSUE-COMMENT-12')
    setUpProject()
    const github = await startGithub([postedComment(COMMENT_URL)])

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue', 'acme/demo/7')

    expect(result).toEqual({ code: 0, stdout: `${COMMENT_URL}\n`, stderr: 'created: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([{ type: 'rest', method: 'POST', path: '/repos/acme/demo/issues/7/comments', body: { body: MERGE_DIFF_BODY } }])
  })

  it.for([
    { name: 'issues の URL', url: 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456' },
    { name: 'pull の URL', url: 'https://ghes.example.com/acme/demo/pull/7#issuecomment-456' },
  ])('comment_url を持つファイルを渡すと、新しいコメントを投稿せずにそのコメントを書き換える（$name）', async ({ url }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-05')
    await verifies(context, 'PW-ISSUE-COMMENT-11')
    await verifies(context, 'PW-ISSUE-COMMENT-13')
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([linkedRepositories(), updatedComment(456, url)])

    const result = await comment(file)

    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: 'updated: comment on acme/demo/7\n' })
    expect(github.requests()).toMatchObject([
      { type: 'graphql', operation: 'GetLinkedRepositoriesUser' },
      { type: 'rest', method: 'PATCH', path: '/repos/acme/demo/issues/comments/456', body: { body: POSTED_BODY } },
    ])
  })

  it('ファイルからコメントを投稿すると、できたコメントの URL をファイルの comment_url に書き戻す', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-06')
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    await comment(file)

    expect(readFileSync(file, 'utf8')).toBe(commentFileContent({ extra: [`comment_url: "${COMMENT_URL}"`] }))
  })

  it('ファイルと -m を一緒に渡すと、-m の本文を使わずにファイルを投稿する', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-08')
    const { file } = setUpCommentProject()
    const github = await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file, '-m', '## 別の本文', '--issue', 'acme/demo/999')

    expect(result.code).toBe(0)
    expect(github.requests()).toMatchObject([{ type: 'graphql' }, { type: 'rest', path: '/repos/acme/demo/issues/7/comments', body: { body: POSTED_BODY } }])
  })

  it('ファイルの Issue のリポジトリがプロジェクトに無いとき、warning の行を標準エラーに出して投稿を続ける', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-14')
    const { file } = setUpCommentProject({ issueRef: 'acme/other/7' })
    const github = await startGithub([
      linkedRepositories(),
      { match: { method: 'POST', path: '/repos/acme/other/issues/7/comments' }, respond: { status: 201, body: { html_url: COMMENT_URL } }, times: 1 },
    ])

    const result = await comment(file)

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: acme/other is not in the project\ncreated: comment on acme/other/7\n')
    expect(github.requests()).toHaveLength(2)
  })

  it('comment_url を書き戻せないとき、warning の行を標準エラーに出して終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-15')
    const { file } = setUpCommentProject()
    chmodSync(file, 0o444)
    await startGithub([linkedRepositories(), postedComment(COMMENT_URL)])

    const result = await comment(file)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${COMMENT_URL}\n`)
    expect(result.stderr).toBe(`created: comment on acme/demo/7\nwarning: could not write comment_url back to the file: [Errno 13] Permission denied: '${file}'\n`)
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの本文がテンプレに合わないとき、違反の種類ごとの行を標準エラーに出し、投稿せずに終了コード 3 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-16')
    await verifies(context, 'PW-ISSUE-COMMENT-17')
    await verifies(context, 'PW-ISSUE-COMMENT-18')
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
  ])('-m の本文がテンプレに合わないとき、違反の行を出し、投稿せずに終了コード 3 で終わる（$name）', async ({ id, message, line }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-16')
    await verifies(context, id)
    setUpProject()
    const github = await startGithub([])

    const result = await comment('-t', 'merge-diff', '-m', message, '--issue', 'acme/demo/7')

    expect(result.code).toBe(3)
    expect(result.stderr.split('\n').some(entry => entry.startsWith(line))).toBe(true)
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: '--prepare に -t が無い', argv: ['--prepare'] },
    { name: '-m に -t が無い', argv: ['-m', MERGE_DIFF_BODY, '--issue', 'acme/demo/7'] },
  ])('テンプレの種類を渡していない（$name）とき、終了コード 1 で終わる', async ({ argv }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-19')
    setUpProject()

    const result = await comment(...argv)

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: specify a template with -t (plan / merge-diff / review-findings / review-resolution / precede-notify)\n',
    })
  })

  it('-m で --issue を渡していないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-20')
    setUpProject()

    const result = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY)

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: --issue (Issue reference) is required with -m\n' })
  })

  it('--prepare・ファイル・-m のどれも渡していないとき、使い方を添えて終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-21')
    setUpProject()

    const result = await comment()

    expect(result.code).toBe(1)
    expect(result.stderr).toBe(
      'error: missing arguments\n'
      + '  direct posting: pecot issue comment -m "MESSAGE" -t <template> --issue owner/repo/123\n'
      + '  prepare a template: pecot issue comment --prepare -t <template>\n'
      + '  from a file: pecot issue comment <path>\n',
    )
  })

  it('ファイルのフロントマターを読めないとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-22')
    const project = setUpProject({ files: { 'note.md': '本文だけで、フロントマターが無い\n' } })
    const file = path.join(project.root, 'note.md')

    const result = await comment(file)

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: frontmatter not found (does not start with ---)\n' })
  })

  it('ファイルのフロントマターに template が無いとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-23')
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
  ])('comment_url が誤っているとき、API を呼ばずに終了コード 1 で終わる（$name）', async ({ url, message }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-24')
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    const github = await startGithub([])

    const result = await comment(file)

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: ${message.replaceAll('\n', '\n  ')}\n` })
    expect(github.requests()).toEqual([])
  })

  it.for([
    { name: 'ファイルを渡した', argv: (file: string): string[] => [file] },
    { name: '-m を渡した', argv: (): string[] => ['-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue', 'acme/demo/7'] },
  ])('アクティブなプロジェクトが無い（$name）とき、終了コード 1 で終わる', async ({ argv }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-25')
    const repository = enterGitRepository({ 'note.md': commentFileContent() })

    const result = await comment(...argv(path.join(repository, 'note.md')))

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'error: no active project\n' })
  })

  it.for([{ status: 500 }, { status: 404 }])('ファイルの投稿で GitHub API が HTTP $status を返したとき、終了コード 1 で終わる', async ({ status }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-26')
    const { file } = setUpCommentProject()
    await startGithub([linkedRepositories(), failedPost(status)])

    const result = await comment(file)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
    expect(readFileSync(file, 'utf8')).toBe(commentFileContent())
  })

  it('ファイルの書き換えと -m の投稿で GitHub API がエラーを返したとき、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-26')
    const url = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-456'
    const { file } = setUpCommentProject({ extra: [`comment_url: "${url}"`] })
    await startGithub([
      linkedRepositories(),
      { match: { method: 'PATCH', path: '/repos/acme/demo/issues/comments/456' }, respond: { status: 500, body: { message: 'failure' } }, times: 1 },
      failedPost(500),
    ])

    const updated = await comment(file)
    const direct = await comment('-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue', 'acme/demo/7')

    expect(updated.code).toBe(1)
    expect(updated.stderr).toContain('error: could not update the comment on Issue acme/demo/7: ')
    expect(direct.code).toBe(1)
    expect(direct.stderr).toContain('error: could not create a comment on Issue acme/demo/7: ')
  })

  it.for([
    { name: 'ファイルの issue_ref', argv: (file: string): string[] => [file], issueRef: 'invalid-format' },
    { name: '--issue', argv: (): string[] => ['-t', 'merge-diff', '-m', MERGE_DIFF_BODY, '--issue', 'invalid-format'], issueRef: 'acme/demo/7' },
  ])('Issue の参照の形が誤っている（$name）とき、終了コード 2 で終わる', async ({ argv, issueRef }, context) => {
    await verifies(context, 'PW-ISSUE-COMMENT-27')
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
})
