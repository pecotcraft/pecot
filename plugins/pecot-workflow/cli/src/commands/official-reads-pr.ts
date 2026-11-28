// pr_check・pr_restack が受ける、公式の GitHub MCP（v2.3.0）の PR と Issue の読み取りの結果の形と、domain の型への写し
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod が推論する結果の型は readonly にできない */
import { z } from 'zod'

import type { IssueKind } from '@pecot/workflow-core/domain/issue-kind.js'
import type { PullRequestReadout } from '@pecot/workflow-core/domain/issue-readout.js'
import { referenceFromUrl } from './official-reads.js'

const BRANCH = z.looseObject({
  ref: z.string(),
  sha: z.string().optional(),
  repo: z.looseObject({ full_name: z.string() }).nullable().optional(),
})

// REST の一覧は merged を持たないので、マージ済みは merged_at で見分ける
const LISTED_PULL_REQUEST = z.looseObject({
  number: z.number().int(),
  state: z.string().optional(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  html_url: z.string(),
  head: BRANCH.optional(),
  base: BRANCH.optional(),
})

/**
list_pull_requests の structuredContent。公式のサーバは配列（か null）を返す
*/
export const LISTED_PULL_REQUESTS = z.array(LISTED_PULL_REQUEST).nullable()

export type ListedPullRequests = z.infer<typeof LISTED_PULL_REQUESTS>

const SUB_ISSUES_SUMMARY = z.looseObject({ total: z.number().int() })

/**
issue_read（method: get）の structuredContent のうち、Epic かを決める項目
*/
export const ISSUE_KIND_READ = z.looseObject({
  issue: z.looseObject({
    number: z.number().int(),
    html_url: z.string(),
    issue_type: z.string().nullable().optional(),
    sub_issues_summary: SUB_ISSUES_SUMMARY.nullable().optional(),
  }),
})

export type IssueKindRead = z.infer<typeof ISSUE_KIND_READ>

function stateOf(pull: z.infer<typeof LISTED_PULL_REQUEST>): PullRequestReadout['state'] | undefined {
  if (pull.merged === true || (pull.merged_at !== undefined && pull.merged_at !== null && pull.merged_at !== '')) return 'MERGED'
  const state = pull.state?.toLowerCase()
  if (state === 'open') return 'OPEN'
  return state === 'closed' ? 'CLOSED' : undefined
}

/**
list_pull_requests の結果を PR の読み出しにする。html_url が PR の URL でないものと、head・base の無いものは飛ばす
*/
export function pullRequestReadoutsOf(read: ListedPullRequests): readonly PullRequestReadout[] {
  return (read ?? []).flatMap((pull): PullRequestReadout | [] => {
    const reference = referenceFromUrl(pull.html_url)
    const state = stateOf(pull)
    if (reference === undefined || state === undefined || pull.head === undefined || pull.base === undefined) return []
    const headRepository = pull.head.repo?.full_name.toLowerCase()
    const baseRepository = pull.base.repo?.full_name.toLowerCase()
    return {
      repository: reference.repository,
      number: pull.number,
      state,
      headRefName: pull.head.ref,
      baseRefName: pull.base.ref,
      isDraft: pull.draft ?? false,
      isCrossRepository: headRepository !== undefined && baseRepository !== undefined && headRepository !== baseRepository,
    }
  })
}

/**
issue_read（get）の結果を、Epic の判定の入力にする
*/
export function issueKindOf(read: IssueKindRead): IssueKind {
  return { issue_type: read.issue.issue_type, sub_issues_total: read.issue.sub_issues_summary?.total }
}
