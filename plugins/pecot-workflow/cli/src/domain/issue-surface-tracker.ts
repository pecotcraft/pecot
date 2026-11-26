// 写しと今のスキーマの差を載せる Tracker の本文と題。dependabot PR の Tracker と同じ印と一覧の形にする。
import { PecotError } from '@pecot/workflow-core/domain/errors.js'
import type { IssueSurface, IssueSurfaceDiff } from './issue-surface.js'
import { normalizeNewlines } from '@pecot/workflow-core/domain/python-format.js'
import { listRegion, markerPatterns } from '@pecot/workflow-core/domain/tracker-body.js'

export class IssueSurfaceTrackerError extends PecotError {}

export const SURFACE_LABEL = 'issue-surface'
const TRACKER_MARKER = '<!-- pecot-issue-surface: tracker -->'
const LIST_BEGIN = '<!-- pecot-issue-surface: list-begin -->'
const LIST_END = '<!-- pecot-issue-surface: list-end -->'
const MARKERS = markerPatterns('pecot-issue-surface')
export const TRACKER_PATTERN = MARKERS.tracker

/**
本文に載せる、比べに使った SDL と OpenAPI の出どころ（URL か、渡されたファイル）
*/
export type IssueSurfaceSourceNames = Pick<IssueSurface['sources'], 'graphql' | 'rest'>

function section(heading: string, ids: readonly string[]): string {
  return `${heading}\n\n${ids.length === 0 ? 'none' : ids.map(id => `- \`${id}\``).join('\n')}`
}

/**
Tracker の本文。existingBody があれば list-begin から list-end の間だけを書き直し、外の文は残す。
existingBody の印が 1 組でなければ IssueSurfaceTrackerError
*/
export function renderTrackerBody(diff: Readonly<IssueSurfaceDiff>, sources: Readonly<IssueSurfaceSourceNames>, existingBody?: string): string {
  const list = [`## Source\n\n- SDL: ${sources.graphql}\n- OpenAPI: ${sources.rest}`, section('## Added', diff.added), section('## Removed', diff.removed)].join('\n\n')
  if (existingBody === undefined) return `${TRACKER_MARKER}\n\n${LIST_BEGIN}\n${list}\n${LIST_END}\n`
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
