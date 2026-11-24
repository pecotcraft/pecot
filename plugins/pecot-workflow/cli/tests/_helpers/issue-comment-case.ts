// issue comment のテストが使う準備。テンプレートに合う本文、コメントのファイル、偽の GitHub の応答。
import path from 'node:path'

import type { ResponseRule } from '../fake-github/server.js'
import { setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const MERGE_DIFF_BODY = [
  '## Merge — 実装は半分まで進んだ',
  '',
  '### Variance — 一覧の取得を検証した',
  '',
  '- 一覧を取得できる — テストで確認した',
  '',
  '### Impact — 画面の表示に着手する',
  '',
  '- 画面を作る — 判断は不要',
  '',
].join('\n')

// merge-diff の見本が指す、マージした PR と、投稿の先頭に付く印
export const MERGE_DIFF_PR = 'acme/demo/12'
export const MERGE_DIFF_MARKER = '<!-- pecot-merge-diff: pr=acme/demo#12 -->'

/**
merge-diff の本文に、投稿のときに付く印を付けたもの
*/
export function markedMergeDiff(body: string): string {
  return `${MERGE_DIFF_MARKER}\n\n${body}`
}

export interface CommentFileOptions {
  /**
  frontmatter の pr_ref の値。既定は template が merge-diff のときだけ MERGE_DIFF_PR。false なら書かない
  */
  readonly pullRequest?: string | false
  /**
  既定は acme/demo/7
  */
  readonly issueRef?: string
  /**
  frontmatter の template の値。既定は merge-diff
  */
  readonly template?: string
  /**
  真なら frontmatter に template の行を書かない
  */
  readonly withoutTemplate?: boolean
  /**
  frontmatter に足す行（例: `comment_url: "..."`）
  */
  readonly extra?: readonly string[]
  readonly body?: string
}

/**
コメントのファイルの内容
*/
export function commentFileContent(options: Readonly<CommentFileOptions> = {}): string {
  const { issueRef: issueReference = 'acme/demo/7', template = 'merge-diff', withoutTemplate = false, extra = [], body = MERGE_DIFF_BODY } = options
  const pullRequest = options.pullRequest ?? (template === 'merge-diff' && !withoutTemplate ? MERGE_DIFF_PR : false)
  const lines = [`issue_ref: "${issueReference}"`, ...withoutTemplate ? [] : [`template: ${template}`], ...pullRequest === false ? [] : [`pr_ref: "${pullRequest}"`], ...extra]
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/**
プロジェクトを用意し、そのルートの直下の note.md にコメントのファイルを置く。file は絶対パス
*/
export function setUpCommentProject(options: Readonly<CommentFileOptions> = {}): ProjectFixture & { readonly file: string } {
  const project = setUpProject({ files: { 'note.md': commentFileContent(options) } })
  return { ...project, file: path.join(project.root, 'note.md') }
}

/**
プロジェクトにリンクされたリポジトリを返す応答（既定は acme/demo だけ）
*/
export function linkedRepositories(names: readonly string[] = ['demo']): ResponseRule {
  const nodes = names.map(name => ({ name, owner: { login: 'acme' } }))
  return {
    match: { operation: 'GetLinkedRepositoriesUser' },
    respond: { status: 200, body: { data: { user: { projectV2: { repositories: { nodes } } } } } },
    times: 1,
  }
}

/**
コメントの投稿（POST）への応答。issue はその Issue の番号
*/
export function postedComment(url: string, issue = 7): ResponseRule {
  return {
    match: { method: 'POST', path: `/repos/acme/demo/issues/${String(issue)}/comments` },
    respond: { status: 201, body: { html_url: url } },
    times: 1,
  }
}

/**
コメントの書き換え（PATCH）への応答
*/
export function updatedComment(id: number, url: string): ResponseRule {
  return {
    match: { method: 'PATCH', path: `/repos/acme/demo/issues/comments/${String(id)}` },
    respond: { status: 200, body: { html_url: url } },
    times: 1,
  }
}

/**
コメントの投稿への失敗の応答
*/
export function failedPost(status: number, issue = 7): ResponseRule {
  return {
    match: { method: 'POST', path: `/repos/acme/demo/issues/${String(issue)}/comments` },
    respond: { status, body: { message: 'failure' } },
    times: 1,
  }
}

export const COMMENT_URL = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-1'
