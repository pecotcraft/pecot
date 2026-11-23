// MCP の resource として出すテンプレートの一覧。中身は cli/templates/ のファイルをそのまま返す。
// comment/review-stopped（review finish が中で使う）と workflow/*（workflow install が置く）は出さない。
import { templateFile } from '../infra/template-store.js'
import { readTextFile } from '../infra/text-file.js'

export const TEMPLATE_URI_SCHEME = 'pecot-template'

export const TEMPLATE_MIME_TYPE = 'text/markdown'

export interface TemplateResource {
  readonly kind: 'comment' | 'issue' | 'pr'
  /**
  ファイル名から拡張子を除いたもの
  */
  readonly name: string
  readonly title: string
  readonly description: string
}

export const TEMPLATE_RESOURCES: readonly TemplateResource[] = [
  { kind: 'comment', name: 'plan', title: 'Plan comment', description: 'Template of the plan comment posted on an Issue before implementation (issue_comment)' },
  { kind: 'comment', name: 'merge-diff', title: 'Merge diff comment', description: 'Template of the comment on how the merged result differs from the plan (issue_comment)' },
  { kind: 'comment', name: 'review-findings', title: 'Review findings comment', description: 'Template of the review findings comment posted on a PR (issue_comment)' },
  { kind: 'comment', name: 'review-resolution', title: 'Review resolution comment', description: 'Template of the comment on how the review findings were addressed (issue_comment)' },
  { kind: 'comment', name: 'precede-notify', title: 'Precede notice comment', description: 'Template of the comment telling a waiting Issue that its prerequisite was merged (issue_comment)' },
  { kind: 'issue', name: 'task', title: 'Task Issue', description: 'Template of a task Issue (issue_create)' },
  { kind: 'issue', name: 'bug', title: 'Bug Issue', description: 'Template of a bug Issue (issue_create)' },
  { kind: 'issue', name: 'epic', title: 'Epic Issue', description: 'Template of an Epic Issue (issue_create)' },
  { kind: 'issue', name: 'tracker', title: 'Tracker Issue', description: 'Template of a tracker Issue (issue_create)' },
  { kind: 'issue', name: 'task-implement', title: 'Implementation task Issue', description: 'Template of a task Issue for one phase of an implementation plan (issue_create)' },
  { kind: 'pr', name: 'create', title: 'Pull request', description: 'Template of a pull request; leave base empty to let pr_create choose it (pr_create)' },
  { kind: 'pr', name: 'release', title: 'Release pull request', description: 'Template of a release pull request (pr_create with template release)' },
]

export function templateUri(template: Readonly<TemplateResource>): string {
  return `${TEMPLATE_URI_SCHEME}://${template.kind}/${template.name}`
}

/**
resource の name。kind と name を / でつなぐ
*/
export function templateResourceName(template: Readonly<TemplateResource>): string {
  return `${template.kind}/${template.name}`
}

export function readTemplate(template: Readonly<TemplateResource>): string {
  return readTextFile(templateFile(template.kind, template.name))
}
