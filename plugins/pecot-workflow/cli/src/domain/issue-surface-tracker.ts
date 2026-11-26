// 写しと今のスキーマの差を載せる Tracker の本文と題。dependabot PR の Tracker と同じ印と一覧の形にする。
import { PecotError } from './errors.js'
import type { IssueSurface, IssueSurfaceDiff } from './issue-surface.js'
import { normalizeNewlines } from './python-format.js'
import { listRegion, markerPatterns } from './tracker-body.js'

export class IssueSurfaceTrackerError extends PecotError {}

export const SURFACE_LABEL = 'issue-surface'
const TRACKER_MARKER = '<!-- pecot-issue-surface: tracker -->'
const LIST_BEGIN = '<!-- pecot-issue-surface: list-begin -->'
const LIST_END = '<!-- pecot-issue-surface: list-end -->'
const MARKERS = markerPatterns('pecot-issue-surface')
export const TRACKER_PATTERN = MARKERS.tracker

/**
本文に載せる、比べに使った SDL と OpenAPI の出どころ（URL か、渡されたファイル）と REST の版
*/
export type IssueSurfaceSourceNames = Pick<IssueSurface['sources'], 'graphql' | 'rest' | 'rest_api_version'>

function section(heading: string, ids: readonly string[]): string {
  return `${heading}\n\n${ids.length === 0 ? 'none' : ids.map(id => `- \`${id}\``).join('\n')}`
}

function introOf(sources: Readonly<IssueSurfaceSourceNames>): string {
  return [
    'GitHub の今のスキーマに、Issue の機能の写し（`plugins/pecot-workflow/interface/github-issue-surface.json`）と違う項目があります。一覧は毎時の実行が書き直します。',
    '',
    '比べたスキーマは次のとおりです。',
    '',
    `- SDL: ${sources.graphql}`,
    `- OpenAPI: ${sources.rest}`,
    `- REST API の版: ${sources.rest_api_version}`,
    '',
    '直すには、`plugins/pecot-workflow/CONTRIBUTING.md` の「4. GitHub の Issue の機能の写しと担保の一覧」に従って、写しと担保の一覧を更新します。差が無くなると、次の実行でこの Tracker は閉じます。',
  ].join('\n')
}

/**
Tracker の本文。existingBody があれば list-begin から list-end の間だけを書き直し、外の文は残す。
existingBody の印が 1 組でなければ IssueSurfaceTrackerError
*/
export function renderTrackerBody(diff: Readonly<IssueSurfaceDiff>, sources: Readonly<IssueSurfaceSourceNames>, existingBody?: string): string {
  const list = `${section('## Added', diff.added)}\n\n${section('## Removed', diff.removed)}`
  if (existingBody === undefined) return `${TRACKER_MARKER}\n\n${introOf(sources)}\n\n${LIST_BEGIN}\n${list}\n${LIST_END}\n`
  const text = normalizeNewlines(existingBody)
  const { begin, end } = listRegion(text, MARKERS.begin, MARKERS.end, IssueSurfaceTrackerError)
  return `${text.slice(0, begin)}\n${list}\n${text.slice(end)}`
}

/**
Tracker の題。today は立てた日（UTC）の YYYY-MM-DD
*/
export function buildTrackerTitle(today: string): string {
  return `[Tracker] GitHub issue surface — ${today}`
}
