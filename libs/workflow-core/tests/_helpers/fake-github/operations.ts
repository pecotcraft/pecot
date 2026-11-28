// GraphQL の要求の識別子（identify.ts）と、シナリオに書く operation 名の対応表。
// 名前は src/infra/github/queries.ts の定数名を PascalCase にしたもの。
// 名前を持つ operation（CreateLinkedBranch）は、query に書かれた名前をそのまま使う。
import { parseOperation } from './identify.js'

const OPERATION_TABLE: readonly (readonly [string, string])[] = [
  ['node{items,field}|cursor,laneFieldName,projectId', 'ListProjectItems'],
  // 構造は ListProjectItems と同じなので、query に書いた名前で引く。識別子は重ならない印を付ける
  ['node{items,field}|cursor,laneFieldName,projectId#named', 'ListProjectItemsLegacy'],
  ['repository.issue{id,title}|number,owner,repo', 'GetIssueNodeId'],
  ['user.projectV2{id}|owner,projectNumber', 'GetProjectIdUser'],
  ['organization.projectV2{id}|owner,projectNumber', 'GetProjectIdOrg'],
  ['repository{id}|name,owner', 'GetRepositoryId'],
  ['linkProjectV2ToRepository.repository{id,nameWithOwner}|projectId,repositoryId', 'LinkProjectRepository'],
  ['addProjectV2ItemById.item{id}|contentId,projectId', 'AddToProject'],
  ['updateProjectV2ItemFieldValue.projectV2Item{id}|fieldId,itemId,optionId,projectId', 'UpdateProjectItemField'],
  ['deleteProjectV2Item{deletedItemId}|itemId,projectId', 'DeleteProjectItem'],
  ['addSubIssue{issue,subIssue}|childId,parentId', 'AddSubIssue'],
  ['createLinkedBranch.linkedBranch.ref{name,prefix}|input', 'CreateLinkedBranch'],
  ['node{nameWithOwner,ref,repository}|id,qualifiedName', 'GetBranchRefByNode'],
  ['repository.issue{id,linkedBranches}|number,owner,repo', 'GetIssueLinkedBranches'],
  ['repository.issue.projectItems.nodes{id,isArchived,project,fieldValues,fieldValueByName}|number,owner,repo', 'GetIssueProjectItems'],
  ['user.projectV2{id,title,url,fields,views}|owner,projectNumber', 'GetProjectFieldsUser'],
  ['organization.projectV2{id,title,url,fields,views}|owner,projectNumber', 'GetProjectFieldsOrg'],
  ['createProjectV2Field.projectV2Field{id,name,options}|name,options,projectId', 'CreateProjectField'],
  ['updateProjectV2Field.projectV2Field{id,name,options}|fieldId,options', 'UpdateProjectField'],
  ['updateProjectV2Field.projectV2Field{id,name}|fieldId,name', 'RenameProjectField'],
  ['deleteProjectV2Field.projectV2Field{id,name}|fieldId', 'DeleteProjectField'],
  ['repository.issue{number,state,issueType,subIssues}|number,owner,repo', 'GetIssueKind'],
  ['repository.issue{number,state,subIssues}|number,owner,repo', 'GetIssueKindPhase1'],
  ['repository.issue{number,state,title,body,comments,parent,subIssues,linkedBranches,timelineItems,blockedBy}|commentLimit,number,owner,repo', 'GetIssueSlim'],
  // 構造は GetIssueSlim から blockedBy を除いたもの。query に書いた名前で引く。識別子は重ならない
  ['repository.issue{number,state,title,body,comments,parent,subIssues,linkedBranches,timelineItems}|commentLimit,number,owner,repo#named', 'GetIssueSlimWithoutBlockedBy'],
  ['repository.issue.subIssues{nodes,pageInfo}|after,number,owner,repo', 'GetSubIssuesPage'],
  ['repository.pullRequest{number,state,body,headRefName,baseRefName,isDraft,closingIssuesReferences,baseRepository}|number,owner,repo', 'GetPullRequestForFinish'],
  ['repository.pullRequests{pageInfo,nodes}|after,owner,repo', 'ListOpenPullRequests'],
  ['addBlockedBy{issue,blockingIssue}|blockingIssueId,issueId', 'AddBlockedBy'],
  ['removeBlockedBy{issue,blockingIssue}|blockingIssueId,issueId', 'RemoveBlockedBy'],
  ['repository.issue{id,number,state,title,repository,issueType,subIssues,projectItems,linkedBranches,closedByPullRequestsReferences,body,parent,blockedBy}|blockedByFirst,labelFieldName,number,owner,repo', 'GetIssuePrerequisites'],
  ['repository.pullRequests{pageInfo,nodes}|headRefName,owner,repo', 'ListPullRequestsByHead'],
  ['repository.issue.blocking{totalCount,nodes}|blockingFirst,number,owner,repo', 'GetIssueBlockingReferences'],
  ['repository.issue{number,title,state,url,repository,projectItems}|number,owner,repo', 'GetIssueBoardItem'],
  ['repositoryOwner{__typename,databaseId,projectV2}|owner,projectNumber', 'GetProjectViewTarget'],
]

export const OPERATION_NAMES: ReadonlySet<string> = new Set(OPERATION_TABLE.map(([, name]) => name))

const OPERATION_BY_ID: ReadonlyMap<string, string> = new Map(OPERATION_TABLE)

/**
表に重複が無いことを確かめるテストが使う
*/
export function operationTable(): readonly (readonly [string, string])[] {
  return OPERATION_TABLE
}

/**
GraphQL の query から operation 名を引く。表に無ければ undefined
*/
export function operationNameOf(query: string): string | undefined {
  const parsed = parseOperation(query)
  return parsed.name ?? OPERATION_BY_ID.get(parsed.id)
}
