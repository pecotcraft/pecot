/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側（コマンドの引数）が決める。この層は読むだけ */
// フロントマター付き Markdown ファイルの読み込み。パースそのものは domain/frontmatter.ts が行う。

import { existsSync } from 'node:fs'

import { FrontmatterError, parseCommentContent, parseFrontmatter, parsePullRequestContent } from '../domain/frontmatter.js'
import type { ParsedComment, ParsedIssue, ParsedPullRequest } from '../domain/frontmatter.js'

import { normalizePath } from './paths.js'
import { readTextFile } from './text-file.js'

function readFrontmatterFile(file: string): string {
  if (!existsSync(file)) throw new FrontmatterError(`ファイルが見つかりません: ${normalizePath(file)}`)
  return readTextFile(file)
}

/**
Issue 用のファイルをパースする。ファイルが無い・パースできないときは FrontmatterError
*/
export function parseIssueFile(file: string): ParsedIssue {
  return parseFrontmatter(readFrontmatterFile(file))
}

/**
コメント用のファイルをパースする。ファイルが無い・パースできないときは FrontmatterError
*/
export function parseCommentFile(file: string): ParsedComment {
  return parseCommentContent(readFrontmatterFile(file))
}

/**
PR 用のファイルをパースする。ファイルが無い・パースできないときは FrontmatterError
*/
export function parsePullRequestFile(file: string): ParsedPullRequest {
  return parsePullRequestContent(readFrontmatterFile(file))
}
