// GitHub Projects (v2) 操作の API。cli/core/github/projects.py の移植。
// owner が user か organization かは分からないので、user のクエリを先に試し、失敗したら organization を試す。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { LinkedRepository } from '../../domain/config.js'
import type { FieldOptionInput } from '../../domain/field-options.js'
import type { BoardItem } from '../../domain/format.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError, isSchemaError } from './errors.js'
import { asArray, asObject, isTruthy, requireString, truthyNodes } from './payload.js'
import {
  MUTATION_ADD_TO_PROJECT,
  MUTATION_CREATE_PROJECT,
  MUTATION_CREATE_PROJECT_FIELD,
  MUTATION_DELETE_PROJECT_ITEM,
  MUTATION_LINK_PROJECT_REPOSITORY,
  MUTATION_UPDATE_PROJECT_FIELD,
  MUTATION_UPDATE_PROJECT_ITEM_FIELD,
  QUERY_GET_ISSUE_BOARD_ITEM,
  QUERY_GET_ISSUE_PROJECT_ITEMS,
  QUERY_GET_LINKED_REPOSITORIES_ORG,
  QUERY_GET_LINKED_REPOSITORIES_USER,
  QUERY_GET_ORG_NODE_ID,
  QUERY_GET_PROJECT_FIELDS_ORG,
  QUERY_GET_PROJECT_FIELDS_USER,
  QUERY_GET_PROJECT_ID_ORG,
  QUERY_GET_PROJECT_ID_USER,
  QUERY_GET_USER_NODE_ID,
  QUERY_LIST_PROJECT_ITEMS,
  QUERY_LIST_PROJECT_ITEMS_LEGACY,
  QUERY_LIST_PROJECTS_ORG,
  QUERY_LIST_PROJECTS_USER,
} from './queries.js'
import { ReposApi } from './repos.js'

// 着手の判定に足したフィールドの名前が出るスキーマの失敗（`Field 'x' doesn't exist` と `Cannot query field "x"`）
const READINESS_FIELD_ERROR = /(?:Field '|field ")(?:issueType|subIssues|parent|blockedBy)['"]/u

export interface ListProjectItemsOptions {
  /**
  取得する最大件数。省略または 0 なら全件
  */
  readonly limit?: number | undefined
  /**
  Archived を除外する。連続して 50 件 Archived が続いたら打ち切る
  */
  readonly excludeArchived?: boolean | undefined
  /**
  excludeArchived のとき、ステータスを見るフィールド名
  */
  readonly workflowFieldName?: string | undefined
  /**
  Issue の依存関係に対応しない GHES で、足したフィールドを除いたクエリで読み直したときに呼ぶ
  */
  readonly onLegacy?: (() => void) | undefined
}

/**
SingleSelect フィールドの選択肢
*/
export type ProjectFieldOption = Readonly<{ name: string, color: string, description: string }>

/**
プロジェクトへのリンクの結果。detail は GitHub の message をそのまま入れる（成功時は空文字列）
*/
export interface LinkResult {
  readonly status: 'linked' | 'already_linked' | 'failed'
  readonly detail: string
}

const MAX_ARCHIVED_CONSECUTIVE = 50
const DEFAULT_PROJECT_LIMIT = 20

function lowerText(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

// ワークフローのフィールドの値が Archived か。そのフィールドが無ければ false
function isItemArchived(item: JsonValue, workflowFieldName: string): boolean {
  const target = workflowFieldName.toLowerCase()
  const fieldValues = truthyNodes(jsonField(item, 'fieldValues'))
  for (const node of fieldValues) {
    if (lowerText(jsonField(jsonField(node, 'field'), 'name')) === target) return lowerText(jsonField(node, 'name')) === 'archived'
  }
  return false
}

// オブジェクトの要素だけを残す（null などは落とす）
function objectsOf(items: readonly JsonValue[]): readonly JsonObject[] {
  return items.filter(item => isJsonObject(item))
}

function linkedRepositoriesOf(project: JsonValue | undefined): readonly LinkedRepository[] {
  return truthyNodes(jsonField(project, 'repositories')).map(node => ({
    owner: requireString(jsonField(jsonField(node, 'owner'), 'login'), 'repositories.nodes.owner.login'),
    name: requireString(jsonField(node, 'name'), 'repositories.nodes.name'),
  }))
}

export class ProjectsApi extends ReposApi {
  // user のクエリ。GitHub の失敗は、認証エラーとレート制限も含めて undefined にし、org のクエリへ進む。
  // Python と同じ動き
  private async queryAsUser(query: string, variables: Readonly<Record<string, JsonValue>>): Promise<JsonObject | undefined> {
    try {
      return await this.executeGraphql(query, variables)
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return undefined
      throw error
    }
  }

  /**
  プロジェクトボードのアイテムを取得する（ページネーション対応）
  */
  async listProjectItems(projectId: string, options: Readonly<ListProjectItemsOptions> = {}): Promise<readonly JsonObject[]> {
    const { limit, excludeArchived = false, workflowFieldName = '', onLegacy } = options
    let query = QUERY_LIST_PROJECT_ITEMS
    let allItems: JsonValue[] = []
    let cursor: string | null = JSON_NULL
    let archivedConsecutive = 0

    for (;;) {
      let result: JsonObject
      try {
        result = await this.executeGraphql(query, { projectId, cursor })
      }
      catch (error: unknown) {
        // 古い GHES は blockedBy などを知らない。足す前のクエリで先頭から読み直す
        if (query === QUERY_LIST_PROJECT_ITEMS_LEGACY || !isSchemaError(error) || !READINESS_FIELD_ERROR.test(error.message)) throw error
        query = QUERY_LIST_PROJECT_ITEMS_LEGACY
        allItems = []
        cursor = JSON_NULL
        archivedConsecutive = 0
        onLegacy?.()
        continue
      }
      const node = jsonField(result, 'node')
      if (!isTruthy(node)) break

      const itemsData = asObject(jsonField(node, 'items'))
      const nodes = asArray(jsonField(itemsData, 'nodes'))

      if (excludeArchived) {
        for (const item of nodes) {
          if (isItemArchived(item, workflowFieldName)) {
            archivedConsecutive += 1
          }
          else {
            allItems.push(item)
            archivedConsecutive = 0
          }
          if (archivedConsecutive >= MAX_ARCHIVED_CONSECUTIVE) return objectsOf(allItems)
        }
      }
      else {
        allItems.push(...nodes)
      }

      if (limit !== undefined && limit > 0 && allItems.length >= limit) {
        allItems = allItems.slice(0, limit)
        break
      }

      const pageInfo = asObject(jsonField(itemsData, 'pageInfo'))
      if (!isTruthy(pageInfo['hasNextPage'])) break
      // 次のページがあるのに cursor が無いと、先頭から取り直して終わらない
      const endCursor = pageInfo['endCursor']
      if (typeof endCursor !== 'string') throw new GitHubAPIError('could not get the cursor for the next page')
      cursor = endCursor
    }
    return objectsOf(allItems)
  }

  /**
  Issue をプロジェクトボードに追加し、作られたアイテムの ID を返す
  */
  async addToProject(projectId: string, contentId: string): Promise<string> {
    const result = await this.executeGraphql(MUTATION_ADD_TO_PROJECT, { projectId, contentId })
    const item = jsonField(jsonField(result, 'addProjectV2ItemById'), 'item')
    if (!isTruthy(item)) throw new GitHubAPIError('failed to add the item to the project')
    return requireString(jsonField(item, 'id'), 'item.id')
  }

  /**
  プロジェクトアイテムの SingleSelect フィールドの値を更新し、アイテムの ID を返す
  */
  async updateProjectItemField(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<string> {
    const result = await this.executeGraphql(MUTATION_UPDATE_PROJECT_ITEM_FIELD, { projectId, itemId, fieldId, optionId })
    const item = jsonField(jsonField(result, 'updateProjectV2ItemFieldValue'), 'projectV2Item')
    if (!isTruthy(item)) throw new GitHubAPIError('failed to update the field')
    return requireString(jsonField(item, 'id'), 'projectV2Item.id')
  }

  /**
  プロジェクトボードからアイテムを削除し、削除したアイテムの ID を返す
  */
  async deleteProjectItem(projectId: string, itemId: string): Promise<string> {
    const result = await this.executeGraphql(MUTATION_DELETE_PROJECT_ITEM, { projectId, itemId })
    const deletedId = jsonField(jsonField(result, 'deleteProjectV2Item'), 'deletedItemId')
    if (!isTruthy(deletedId)) throw new GitHubAPIError('failed to delete the project item')
    return requireString(deletedId, 'deletedItemId')
  }

  /**
  プロジェクトにリンクされたリポジトリの一覧。user 所有を先に試し、無ければ organization 所有を試す
  */
  async getLinkedRepositories(owner: string, projectNumber: number): Promise<readonly LinkedRepository[]> {
    const variables = { owner, projectNumber }
    const userResult = await this.queryAsUser(QUERY_GET_LINKED_REPOSITORIES_USER, variables)
    const userProject = jsonField(jsonField(userResult, 'user'), 'projectV2')
    if (isTruthy(userProject)) return linkedRepositoriesOf(userProject)

    const orgResult = await this.executeGraphql(QUERY_GET_LINKED_REPOSITORIES_ORG, variables)
    const organizationProject = jsonField(jsonField(orgResult, 'organization'), 'projectV2')
    return isTruthy(organizationProject) ? linkedRepositoriesOf(organizationProject) : []
  }

  /**
  リンクされたリポジトリの一覧（キャッシュ付き）。同じクライアントの中で同じ引数なら、2 回目以降はキャッシュを返す
  */
  async getLinkedRepositoriesCached(owner: string, projectNumber: number): Promise<readonly LinkedRepository[]> {
    const cacheKey = `${owner}/${String(projectNumber)}`
    const cached = this.linkedRepositoriesCache.get(cacheKey)
    if (cached !== undefined) return cached
    const repositories = await this.getLinkedRepositories(owner, projectNumber)
    this.linkedRepositoriesCache.set(cacheKey, repositories)
    return repositories
  }

  /**
  RepositoryMembership（domain/config.ts）の実体。キャッシュ付きの一覧を返す
  */
  async linkedRepositories(owner: string, projectNumber: number): Promise<readonly LinkedRepository[]> {
    return this.getLinkedRepositoriesCached(owner, projectNumber)
  }

  /**
  プロジェクト番号から GraphQL Node ID を取る。user 所有を先に試す。無ければ GitHubNotFoundError
  */
  async getProjectId(owner: string, projectNumber: number): Promise<string> {
    const variables = { owner, projectNumber }
    const userResult = await this.queryAsUser(QUERY_GET_PROJECT_ID_USER, variables)
    const userProject = jsonField(jsonField(userResult, 'user'), 'projectV2')
    if (isTruthy(userProject)) return requireString(jsonField(userProject, 'id'), 'projectV2.id')

    const orgResult = await this.executeGraphql(QUERY_GET_PROJECT_ID_ORG, variables)
    const organizationProject = jsonField(jsonField(orgResult, 'organization'), 'projectV2')
    if (isTruthy(organizationProject)) return requireString(jsonField(organizationProject, 'id'), 'projectV2.id')

    throw new GitHubNotFoundError(`project not found: ${owner}/projects/${String(projectNumber)}`)
  }

  /**
  Issue 番号から、指定のプロジェクトの中のアイテム ID を取る。
  Issue から直接引くので、全アイテムの走査は要らない。Issue やリポジトリが無い、またはプロジェクトに無ければ undefined
  */
  async getItemIdByIssue(projectId: string, owner: string, repository: string, issueNumber: number): Promise<string | undefined> {
    const result = await this.executeGraphql(QUERY_GET_ISSUE_PROJECT_ITEMS, { owner, repo: repository, number: issueNumber })
    const repositoryNode = jsonField(result, 'repository')
    if (!isTruthy(repositoryNode)) return undefined
    const issue = jsonField(repositoryNode, 'issue')
    if (!isTruthy(issue)) return undefined

    const projectItems = truthyNodes(jsonField(issue, 'projectItems'))
    for (const item of projectItems) {
      if (jsonField(jsonField(item, 'project'), 'id') === projectId) return requireString(jsonField(item, 'id'), 'projectItems.nodes.id')
    }
    return undefined
  }

  /**
  Issue 1 件の、指定のプロジェクトの項目を、readBoard の一覧の項目と同じ形で返す（札は含めない）。
  workflow は進行の列の値で、空なら null。Issue やリポジトリが無い、またはプロジェクトに無ければ undefined
  */
  async getIssueBoardItem(projectId: string, owner: string, repository: string, issueNumber: number, workflowFieldName: string): Promise<BoardItem | undefined> {
    const result = await this.executeGraphql(QUERY_GET_ISSUE_BOARD_ITEM, { owner, repo: repository, number: issueNumber, workflowFieldName })
    const issue = jsonField(jsonField(result, 'repository'), 'issue')
    if (!isTruthy(issue)) return undefined
    const item = truthyNodes(jsonField(issue, 'projectItems')).find(node => jsonField(jsonField(node, 'project'), 'id') === projectId)
    if (item === undefined) return undefined
    const workflow = jsonField(jsonField(item, 'workflow'), 'name')
    const owning = jsonField(issue, 'repository')
    return {
      id: requireString(jsonField(item, 'id'), 'projectItems.nodes.id'),
      workflow: typeof workflow === 'string' ? workflow : JSON_NULL,
      title: jsonField(issue, 'title') ?? '',
      content: {
        number: jsonField(issue, 'number') ?? JSON_NULL,
        state: jsonField(issue, 'state') ?? JSON_NULL,
        url: jsonField(issue, 'url') ?? JSON_NULL,
        repository: `${requireString(jsonField(jsonField(owning, 'owner'), 'login'), 'issue.repository.owner.login')}/${requireString(jsonField(owning, 'name'), 'issue.repository.name')}`,
      },
    }
  }

  /**
  プロジェクトアイテムで値が入っている単一選択フィールドの ID を取る。アイテムが見つからなければ空
  */
  async getItemSetFieldIds(projectId: string, owner: string, repository: string, issueNumber: number, itemId: string): Promise<ReadonlySet<string>> {
    const result = await this.executeGraphql(QUERY_GET_ISSUE_PROJECT_ITEMS, { owner, repo: repository, number: issueNumber })
    const issue = jsonField(jsonField(result, 'repository'), 'issue')
    const fieldIds = new Set<string>()
    const items = truthyNodes(jsonField(issue, 'projectItems'))
    for (const item of items) {
      if (jsonField(item, 'id') !== itemId || jsonField(jsonField(item, 'project'), 'id') !== projectId) continue
      const values = truthyNodes(jsonField(item, 'fieldValues'))
      for (const value of values) {
        const fieldId = jsonField(jsonField(value, 'field'), 'id')
        if (typeof fieldId === 'string') fieldIds.add(fieldId)
      }
    }
    return fieldIds
  }

  /**
  プロジェクトにリポジトリをリンクする。
  リンクした（linked）、既にリンク済み（already_linked）、失敗（failed）のいずれも例外にせず結果で返す
  */
  async linkRepositoryToProject(owner: string, projectNumber: number, repositoryOwner: string, repositoryName: string): Promise<LinkResult> {
    try {
      const projectId = await this.getProjectId(owner, projectNumber)
      const repositoryId = await this.getRepositoryId(repositoryOwner, repositoryName)
      const result = await this.executeGraphql(MUTATION_LINK_PROJECT_REPOSITORY, { projectId, repositoryId })

      const linked = jsonField(jsonField(result, 'linkProjectV2ToRepository'), 'repository')
      return isTruthy(linked) ? { status: 'linked', detail: '' } : { status: 'failed', detail: 'unexpected response' }
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) return { status: 'failed', detail: error.message }
      if (error instanceof GitHubAPIError) {
        const lowered = error.message.toLowerCase()
        const isAlreadyLinked = lowered.includes('already linked') || lowered.includes('already exists')
        return { status: isAlreadyLinked ? 'already_linked' : 'failed', detail: error.message }
      }
      throw error
    }
  }

  /**
  オーナーのプロジェクト一覧（number・title・url・id）。user 所有を先に試す
  */
  async listProjects(owner: string, limit = DEFAULT_PROJECT_LIMIT): Promise<readonly JsonObject[]> {
    const variables = { owner, first: limit }
    const userResult = await this.queryAsUser(QUERY_LIST_PROJECTS_USER, variables)
    const userProjects = jsonField(jsonField(userResult, 'user'), 'projectsV2')
    if (isTruthy(userProjects)) return objectsOf(truthyNodes(userProjects))

    const orgResult = await this.executeGraphql(QUERY_LIST_PROJECTS_ORG, variables)
    const organizationProjects = jsonField(jsonField(orgResult, 'organization'), 'projectsV2')
    return isTruthy(organizationProjects) ? objectsOf(truthyNodes(organizationProjects)) : []
  }

  /**
  プロジェクトの情報（id・title・url・fields）。user 所有を先に試す。見つからなければ undefined
  */
  async getProjectFields(owner: string, projectNumber: number): Promise<JsonObject | undefined> {
    const variables = { owner, projectNumber }
    const userResult = await this.queryAsUser(QUERY_GET_PROJECT_FIELDS_USER, variables)
    const userProject = jsonField(jsonField(userResult, 'user'), 'projectV2')
    if (isTruthy(userProject)) return asObject(userProject)

    const orgResult = await this.executeGraphql(QUERY_GET_PROJECT_FIELDS_ORG, variables)
    const organizationProject = jsonField(jsonField(orgResult, 'organization'), 'projectV2')
    return isTruthy(organizationProject) ? asObject(organizationProject) : undefined
  }

  /**
  プロジェクトに SingleSelect フィールドを作り、作ったフィールド（id・name・options）を返す
  */
  async createProjectField(projectId: string, name: string, options: readonly ProjectFieldOption[]): Promise<JsonObject> {
    const result = await this.executeGraphql(MUTATION_CREATE_PROJECT_FIELD, { projectId, name, options })
    const created = jsonField(jsonField(result, 'createProjectV2Field'), 'projectV2Field')
    if (!isTruthy(created)) throw new GitHubAPIError('failed to create the field')
    return asObject(created)
  }

  /**
  SingleSelect フィールドの選択肢を、渡した一覧に置き換え、更新後のフィールド（id・name・options）を返す。
  既存の選択肢は id を付けて渡す（外すと選択肢が作り直され、カードの値が消える）
  */
  async updateProjectFieldOptions(fieldId: string, options: readonly FieldOptionInput[]): Promise<JsonObject> {
    const result = await this.executeGraphql(MUTATION_UPDATE_PROJECT_FIELD, { fieldId, options })
    const updated = jsonField(jsonField(result, 'updateProjectV2Field'), 'projectV2Field')
    if (!isTruthy(updated)) throw new GitHubAPIError('failed to update the field')
    return asObject(updated)
  }

  /**
  オーナー（user か organization）の GraphQL Node ID。user を先に試し、無ければ GitHubNotFoundError
  */
  async getOwnerNodeId(owner: string): Promise<string> {
    const userResult = await this.queryAsUser(QUERY_GET_USER_NODE_ID, { login: owner })
    const userId = jsonField(jsonField(userResult, 'user'), 'id')
    if (isTruthy(userId)) return requireString(userId, 'user.id')

    const orgResult = await this.executeGraphql(QUERY_GET_ORG_NODE_ID, { login: owner })
    const organizationId = jsonField(jsonField(orgResult, 'organization'), 'id')
    if (isTruthy(organizationId)) return requireString(organizationId, 'organization.id')

    throw new GitHubNotFoundError(`owner not found: ${owner}`)
  }

  /**
  GitHub Projects V2 を作り、作ったプロジェクト（id・number・title・url）を返す
  */
  async createProject(ownerId: string, title: string): Promise<JsonObject> {
    const result = await this.executeGraphql(MUTATION_CREATE_PROJECT, { ownerId, title })
    const project = jsonField(jsonField(result, 'createProjectV2'), 'projectV2')
    if (!isTruthy(project)) throw new GitHubAPIError('failed to create the project')
    return asObject(project)
  }
}
