// リポの Actions の secret・variable の名前を読む。workflow doctor と、actions の処理が共有する。

import type { SettingList, SettingNames } from '../domain/workflow-template.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { ActionsScope } from '../infra/github/repos.js'

// 読めた一覧の名前を合わせる。読めなかった一覧があれば complete を false にする
function mergeNames(lists: readonly (readonly string[] | undefined)[]): SettingList {
  return { names: new Set(lists.flatMap(list => list ?? [])), complete: !lists.includes(undefined) }
}

/**
リポの secret と variable の名前。持ち主が Organization なら、organization の分も読む
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない
export async function readSettingNames(client: GitHubClient, owner: string, repository: string): Promise<SettingNames> {
  const ownerType = await client.getRepositoryOwnerType(owner, repository)
  const scopes: readonly ActionsScope[] = ownerType === 'Organization' ? ['repository', 'organization'] : ['repository']
  const [secrets, variables] = await Promise.all([
    Promise.all(scopes.map(async scope => await client.listActionsSecretNames(owner, repository, scope))),
    Promise.all(scopes.map(async scope => await client.listActionsVariableNames(owner, repository, scope))),
  ])
  return { secrets: mergeNames(secrets), variables: mergeNames(variables) }
}
