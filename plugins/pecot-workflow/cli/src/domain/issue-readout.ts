// 前提の読み取り結果の形。infra（GitHub の応答）と domain（Issue の実態へのまとめ）の境目の型。
// infra/github/issues.ts の getIssuePrerequisites がこの形で返し、domain/readiness.ts の toIssueFacts が受ける。

import type { RepositoryReference } from './repository-resolver.js'

/**
GitHub の PR の状態。GraphQL の PullRequestState の値そのまま
*/
export type PullRequestStateReadout = 'OPEN' | 'CLOSED' | 'MERGED'

/**
Issue の状態。GraphQL の IssueState の値そのまま
*/
export type IssueStateReadout = 'OPEN' | 'CLOSED'

export interface PullRequestReadout {
  /**
  PR のあるリポ（base 側）
  */
  readonly repository: RepositoryReference
  readonly number: number
  readonly state: PullRequestStateReadout
  readonly headRefName: string
  readonly baseRefName: string
  readonly isDraft: boolean
  readonly isCrossRepository: boolean
}

/**
ボードの単一選択のフィールドの値 1 つ。設定のプロジェクトに絞った後の値
*/
export interface ProjectFieldValueReadout {
  readonly fieldId: string
  readonly fieldName: string
  readonly optionId: string
  readonly optionName: string
}

export interface LinkedBranchReadout {
  readonly name: string
  /**
  このブランチを head に持つ PR
  */
  readonly pullRequests: readonly PullRequestReadout[]
}

export interface IssueReadout {
  /**
  GraphQL の node ID
  */
  readonly id: string
  readonly repository: RepositoryReference
  readonly number: number
  readonly state: IssueStateReadout
  readonly title: string
  /**
  Issue Type の名前。無い、または issueType に対応しない GHES では null
  */
  readonly issueType: string | null
  readonly subIssuesTotal: number
  /**
  設定のプロジェクトのアイテムの値。ボードに無ければ空
  */
  readonly projectFieldValues: readonly ProjectFieldValueReadout[]
  readonly linkedBranches: readonly LinkedBranchReadout[]
  /**
  closedByPullRequestsReferences(includeClosedPrs: true) の PR
  */
  readonly closingPullRequests: readonly PullRequestReadout[]
  /**
  timelineItems の PR。ConnectedEvent のうち後で外されていないものと、CrossReferencedEvent のうち閉じる参照か、head が `/<Issue 番号>` で終わるもの
  */
  readonly timelinePullRequests: readonly PullRequestReadout[]
}

export interface TargetIssueReadout extends IssueReadout {
  readonly body: string
  /**
  親の Issue（sub-issue の親）。親が無い、または応答に無ければ null
  */
  readonly parent: { readonly repository: RepositoryReference, readonly number: number } | null
}

/**
blockedBy の読み取り結果。読めない部分があるときは read-failed。
読めない部分とは、blockedBy の null の node・エラー・件数不足と、対象と前提の Issue の connection の取りこぼし
*/
export type BlockedByReadout
  = | { readonly kind: 'ok', readonly issues: readonly IssueReadout[] }
    | { readonly kind: 'read-failed', readonly reason: string }

export interface IssuePrerequisitesReadout {
  readonly issue: TargetIssueReadout
  readonly blockedBy: BlockedByReadout
}

/**
ボードのフィールド名。getIssuePrerequisites が値を取る 2 つ
*/
export interface PrerequisiteFieldNames {
  /**
  進行の欄のフィールド名
  */
  readonly columnFieldName: string
  /**
  札のフィールド名
  */
  readonly labelFieldName: string
}

/**
head のブランチ名で引いた PR。新しい順
*/
export interface PullRequestsByHeadReadout {
  readonly pullRequests: readonly PullRequestReadout[]
  /**
  先頭の件数に収まらず、続きがあるか
  */
  readonly hasNextPage: boolean
}
