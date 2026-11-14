/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時 root 配下のみ */
// pr と session finish のテストが共有する、一時の作業場所と偽の GitHub が受けた要求の読み方。
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { rule } from './workspace.js'
import type { Workspace } from './workspace.js'

/**
Issue の種別の問い合わせに 500 を返す応答
*/
export const KIND_FAILURE = rule({ operation: 'GetIssueKind' }, { status: 500, body: { message: 'Server Error' } })

/**
空でない行
*/
export function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

/**
受けた REST の要求のうち、method（と、渡せば path）が合うもの
*/
export function restRequests(workspace: Readonly<Workspace>, method: string, requestPath?: string): unknown[] {
  return workspace.requests().filter(request => request.type === 'rest' && request.method === method && (requestPath === undefined || request.path === requestPath))
}

/**
受けた要求を、GraphQL は操作名、REST は `METHOD path` にして順に並べる
*/
export function operationsOf(workspace: Readonly<Workspace>): string[] {
  return workspace.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

/**
状態のファイルの、作業場所からの相対パス
*/
export function stateFile(name: string): string {
  return `.pecot/state/${name}`
}

/**
.git を除く全部のファイルの `相対パス:大きさ:更新時刻`。触っていないことを比べるのに使う
*/
export function filesOf(directory: string): string[] {
  const entries = readdirSync(directory, { recursive: true, encoding: 'utf8' })
  return entries
    .filter(relative => relative !== '.git' && !relative.startsWith('.git/'))
    .map((relative) => {
      const stat = lstatSync(path.join(directory, relative))
      return `${relative}:${String(stat.size)}:${String(stat.mtimeMs)}`
    })
}
