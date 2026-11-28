/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない */
// GitHub の Issue の機能の写し（interface/github-issue-surface.json）と担保の一覧の形、その照らし合わせと、今のスキーマとの差。
// SDL と OpenAPI から項目を抜く処理は graphql を読むので、actions の src/infra/issue-surface.ts に置く。
import { z } from 'zod'

import { compareCodePoints } from './fuzzy.js'

const COVERAGE_FILE = 'issue-coverage.yaml'

const SURFACE_FILE = 'github-issue-surface.json'

const coverageEntrySchema = z.strictObject({
  id: z.string(),
  status: z.enum(['supported', 'excluded']),
  handler: z.string().optional(),
  tool: z.string().optional(),
  reason: z.string().optional(),
})

/**
担保の一覧（issue-coverage.yaml）の形。組み合わせの誤りは id を挙げるため checkIssueCoverage で見る
*/
export const issueCoverageSchema = z.strictObject({ items: z.array(coverageEntrySchema) })

export type IssueCoverage = z.infer<typeof issueCoverageSchema>

type CoverageEntry = IssueCoverage['items'][number]

/**
写し（github-issue-surface.json）の形
*/
export const issueSurfaceSchema = z.strictObject({
  sources: z.strictObject({ graphql: z.string(), rest: z.string(), rest_api_version: z.string(), fetched_at: z.string() }),
  items: z.array(z.string()),
})

export type IssueSurface = z.infer<typeof issueSurfaceSchema>

function entryProblems(entry: Readonly<CoverageEntry>, handlers: ReadonlySet<string>, tools: ReadonlySet<string>): string[] {
  const { handler, tool } = entry
  if (entry.status === 'excluded') {
    if (handler !== undefined || tool !== undefined) return ['excluded must not have handler or tool']
    return (entry.reason ?? '').trim() === '' ? ['excluded needs a reason'] : []
  }
  if (entry.reason !== undefined) return ['supported must not have a reason']
  if ((handler === undefined) === (tool === undefined)) return ['supported needs exactly one of handler or tool']
  if (handler !== undefined && !handlers.has(handler)) return [`handler ${handler} is not in ATTRIBUTE_HANDLERS`]
  if (tool !== undefined && !tools.has(tool)) return [`tool ${tool} is not an MCP tool of TOOLS`]
  return []
}

/**
写しの項目と担保の一覧を照らし、問題を「id: 文」の形で id の順に返す。問題が無ければ空。
handlers は ATTRIBUTE_HANDLERS の鍵、tools は TOOLS の MCP のツール名
*/
export function checkIssueCoverage(items: readonly string[], coverage: Readonly<IssueCoverage>, handlers: readonly string[], tools: readonly string[]): string[] {
  const surface = new Set(items)
  const handlerSet = new Set(handlers)
  const toolSet = new Set(tools)
  const seen = new Set<string>()
  const problems: (readonly [string, string])[] = []
  for (const entry of coverage.items) {
    if (seen.has(entry.id)) problems.push([entry.id, 'listed more than once'])
    seen.add(entry.id)
    if (!surface.has(entry.id)) problems.push([entry.id, `not in ${SURFACE_FILE}`])
    for (const problem of entryProblems(entry, handlerSet, toolSet)) problems.push([entry.id, problem])
  }
  for (const id of items) {
    if (!seen.has(id)) problems.push([id, `not in ${COVERAGE_FILE}`])
  }
  return problems
    .toSorted(([leftId, left], [rightId, right]) => compareCodePoints(leftId, rightId) || compareCodePoints(left, right))
    .map(([id, problem]) => `${id}: ${problem}`)
}

/**
写しと今の抜き出しの差。added は今にあって写しに無い id、removed は写しにあって今に無い id。どちらも符号位置の順
*/
export interface IssueSurfaceDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export function diffIssueSurface(snapshot: readonly string[], current: readonly string[]): IssueSurfaceDiff {
  const before = new Set(snapshot)
  const after = new Set(current)
  return {
    added: [...after].filter(id => !before.has(id)).toSorted(compareCodePoints),
    removed: [...before].filter(id => !after.has(id)).toSorted(compareCodePoints),
  }
}

export function hasIssueSurfaceDifference(diff: Readonly<IssueSurfaceDiff>): boolean {
  return diff.added.length > 0 || diff.removed.length > 0
}
