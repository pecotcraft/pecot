// pr と session finish のテストが共有する、一時の作業場所と偽の GitHub が受けた要求の読み方。
import type { Workspace } from './workspace.js'

/**
空でない行
*/
export function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
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
