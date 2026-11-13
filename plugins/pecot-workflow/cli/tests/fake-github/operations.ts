// GraphQL の要求の識別子（identify.ts）と、シナリオに書く operation 名の対応表。
// 名前は src/infra/github/queries.ts の定数名を PascalCase にしたもの。
// 名前を持つ operation（CreateLinkedBranch）は、query に書かれた名前をそのまま使う。
import { parseOperation } from './identify.js'

const OPERATION_TABLE: readonly (readonly [string, string])[] = [
  ['node.items{nodes,pageInfo}|cursor,projectId', 'ListProjectItems'],
  ['node.items{nodes,pageInfo}|cursor,filterQuery,projectId', 'ListProjectItemsFiltered'],
  ['repository.issue{id,title}|number,owner,repo', 'GetIssueNodeId'],
  ['user.projectV2.repositories.nodes{owner,name}|owner,projectNumber', 'GetLinkedRepositoriesUser'],
  ['organization.projectV2.repositories.nodes{owner,name}|owner,projectNumber', 'GetLinkedRepositoriesOrg'],
  ['user.projectV2{id}|owner,projectNumber', 'GetProjectIdUser'],
  ['organization.projectV2{id}|owner,projectNumber', 'GetProjectIdOrg'],
  ['repository{id}|name,owner', 'GetRepositoryId'],
  ['linkProjectV2ToRepository.repository{id,nameWithOwner}|projectId,repositoryId', 'LinkProjectRepository'],
  ['addProjectV2ItemById.item{id}|contentId,projectId', 'AddToProject'],
  ['updateProjectV2ItemFieldValue.projectV2Item{id}|fieldId,itemId,optionId,projectId', 'UpdateProjectItemField'],
  ['deleteProjectV2Item{deletedItemId}|itemId,projectId', 'DeleteProjectItem'],
  ['addSubIssue{issue,subIssue}|childId,parentId', 'AddSubIssue'],
  ['createLinkedBranch.linkedBranch.ref{name,prefix}|input', 'CreateLinkedBranch'],
  ['repository.issue.projectItems.nodes{id,project,fieldValues}|number,owner,repo', 'GetIssueProjectItems'],
  ['user.projectsV2.nodes{number,title,url,id}|first,owner', 'ListProjectsUser'],
  ['organization.projectsV2.nodes{number,title,url,id}|first,owner', 'ListProjectsOrg'],
  ['user.projectV2{id,title,url,fields,views}|owner,projectNumber', 'GetProjectFieldsUser'],
  ['organization.projectV2{id,title,url,fields,views}|owner,projectNumber', 'GetProjectFieldsOrg'],
  ['createProjectV2Field.projectV2Field{id,name,options}|name,options,projectId', 'CreateProjectField'],
  ['updateProjectV2Field.projectV2Field{id,name,options}|fieldId,options', 'UpdateProjectField'],
  ['user{id}|login', 'GetUserNodeId'],
  ['organization{id}|login', 'GetOrgNodeId'],
  ['createProjectV2.projectV2{id,number,title,url}|ownerId,title', 'CreateProject'],
  ['repository.issue{number,state,issueType,subIssues}|number,owner,repo', 'GetIssueKind'],
  ['repository.issue{number,state,subIssues}|number,owner,repo', 'GetIssueKindPhase1'],
  ['repository.issue{number,state,title,body,comments,parent,subIssues,linkedBranches,timelineItems}|commentLimit,number,owner,repo', 'GetIssueSlim'],
  ['repository.issue.subIssues{nodes,pageInfo}|after,number,owner,repo', 'GetSubIssuesPage'],
  ['repository.pullRequest{number,state,title,body,headRefName,baseRefName,isDraft,mergeable,comments,closingIssuesReferences,reviews}|number,owner,repo', 'GetPullRequestSlim'],
  ['repository.pullRequest{number,state,title,body,headRefName,baseRefName,isDraft,mergeable,comments,closingIssuesReferences,reviews,reviewThreads}|number,owner,repo', 'GetPullRequestWithReviews'],
  ['repository.pullRequests{pageInfo,nodes}|after,owner,repo', 'ListOpenPullRequests'],
  ['addBlockedBy{issue,blockingIssue}|blockingIssueId,issueId', 'AddBlockedBy'],
  ['removeBlockedBy{issue,blockingIssue}|blockingIssueId,issueId', 'RemoveBlockedBy'],
  ['repository.issue{id,number,state,title,repository,issueType,subIssues,projectItems,linkedBranches,closedByPullRequestsReferences,timelineItems,body,blockedBy}|columnFieldName,labelFieldName,number,owner,repo', 'GetIssuePrerequisites'],
  ['repository.pullRequests{pageInfo,nodes}|headRefName,owner,repo', 'ListPullRequestsByHead'],
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
