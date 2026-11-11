import type { z } from 'zod'
import type { Finding } from './finding.js'
import { OUTPUT_FORMATS } from './schema.js'
import { isRecord } from './utility.js'

export type FileKind = 'generated' | 'authored' | 'targets'
type PathPart = string | number

// 欄が欠けているときに添える「使わないときの値」。entries の直下の欄と、ファイルの先頭の欄にだけ付く。
const UNUSED_VALUES: Readonly<Record<string, string>> = {
  constraints: 'write [] if none',
  stdin: 'write "none" if nothing is read',
  output: 'write "format: none" if nothing is printed',
  diagnostics: 'write "default" if nothing else is printed',
  environment: 'write [] if none',
  on_error: 'write "default" if nothing remains',
  effects: 'write [] if none',
  prerequisites: 'write [] if none',
  default_notes: 'write {} if none',
  common_behaviors: 'write [] if none',
}

function valueAt(root: unknown, path: readonly PathPart[]): unknown {
  let current = root
  for (const part of path) {
    if (typeof part === 'number' && Array.isArray(current)) current = current[part]
    else if (isRecord(current)) current = current[String(part)]
    else return undefined
  }
  return current
}

function isMissing(root: unknown, path: readonly PathPart[]): boolean {
  const key = path.at(-1)
  if (key === undefined) return false
  const parent = valueAt(root, path.slice(0, -1))
  return Array.isArray(parent) ? typeof key === 'number' && key >= parent.length : isRecord(parent) && !Object.hasOwn(parent, String(key))
}

function expectedValues(values: readonly unknown[]): string {
  const list = values.map(item => JSON.stringify(item))
  return list.length === 1 ? `expected ${list[0] ?? ''}` : `expected one of ${list.join(', ')}`
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

function fieldOf(path: readonly PathPart[]): string {
  return path.map((part, index) => typeof part === 'number' ? `[${String(part)}]` : (index === 0 ? part : `.${part}`)).join('')
}

interface Location {
  readonly scope?: string
  readonly field: string
}

function behaviorLocation(root: unknown, base: readonly PathPart[], rest: readonly PathPart[]): Location | undefined {
  const index = rest[0]
  if (typeof index !== 'number') return undefined
  const behavior = valueAt(root, [...base, index])
  if (!isRecord(behavior) || typeof behavior['id'] !== 'string') return undefined
  const tail = rest.slice(1)
  return { scope: behavior['id'], field: tail.length === 0 ? 'behavior' : fieldOf(tail) }
}

// zod の path を、行に出す項目の ID と欄に変える。
function locate(root: unknown, path: readonly PathPart[], kind: FileKind): Location {
  const [head, key, ...rest] = path
  if (kind === 'targets' && head === 'plugins' && typeof key === 'string') {
    return { scope: key, field: rest.length === 0 ? 'plugin' : fieldOf(rest) }
  }
  if (kind === 'authored' && head === 'common_behaviors') {
    const found = behaviorLocation(root, ['common_behaviors'], path.slice(1))
    if (found !== undefined) return found
  }
  if (kind !== 'targets' && head === 'entries' && key !== undefined) {
    const entry = valueAt(root, ['entries', key])
    const scope = kind === 'generated' && isRecord(entry) && typeof entry['id'] === 'string' ? entry['id'] : String(key)
    if (kind === 'authored' && rest[0] === 'behaviors') {
      const found = behaviorLocation(root, ['entries', key, 'behaviors'], rest.slice(1))
      if (found !== undefined) return found
    }
    return { scope, field: rest.length === 0 ? 'entry' : fieldOf(rest) }
  }
  return { field: fieldOf(path) }
}

function isUnusedValueSite(path: readonly PathPart[], kind: FileKind): boolean {
  return kind === 'authored' && ((path.length === 3 && path[0] === 'entries') || path.length === 1)
}

function reasonOf(issue: z.core.$ZodIssue, root: unknown, path: readonly PathPart[], kind: FileKind): string {
  const value = valueAt(root, path)
  const isAbsent = isMissing(root, path)
  const isEmpty = issue.code === 'too_small' && issue.origin === 'string' && issue.minimum === 1
  const hint = (isAbsent || isEmpty) && isUnusedValueSite(path, kind) ? UNUSED_VALUES[String(path.at(-1))] : undefined
  const withHint = (reason: string): string => hint === undefined ? reason : `${reason} (${hint})`
  const missingReason = withHint('field is missing')
  if (issue.code === 'invalid_type') {
    return isAbsent ? missingReason : `expected ${issue.expected} but got ${describe(value)}`
  }
  if (issue.code === 'invalid_value') {
    return isAbsent ? missingReason : `unknown value ${JSON.stringify(value)} (${expectedValues(issue.values)})`
  }
  // 判別の欄は output.format だけで、取れる値は OUTPUT_FORMATS。
  if (issue.code === 'invalid_union' && issue.discriminator !== undefined) {
    return isAbsent ? missingReason : `unknown value ${JSON.stringify(value)} (${expectedValues(OUTPUT_FORMATS)})`
  }
  if (isEmpty) return withHint('is empty')
  if (issue.code === 'too_small' && issue.origin === 'array') return `must have at least ${String(issue.minimum)} item(s)`
  // 数の範囲を持つ欄は exit_status[].code だけ（schema.ts の exitCodeSchema の 0〜255）。
  if ((issue.code === 'too_small' || issue.code === 'too_big') && issue.origin === 'number') return 'must be between 0 and 255'
  if (issue.code === 'custom') return issue.message
  return `unknown validation issue (${issue.code}): ${issue.message}`
}

export function pathOf(issue: z.core.$ZodIssue): PathPart[] {
  return issue.path.map(part => typeof part === 'number' ? part : String(part))
}

// zod の issue を 1 件 1 行の Finding に変える。知らない種類の issue も必ず行にする。
export function issuesToFindings(issues: readonly z.core.$ZodIssue[], file: string, root: unknown, kind: FileKind): Finding[] {
  return issues.flatMap((issue) => {
    const path = pathOf(issue)
    const paths = issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...path, key]) : [path]
    return paths.map((target) => {
      const location = locate(root, target, kind)
      return {
        file,
        ...(location.scope !== undefined && { scope: location.scope }),
        field: location.field,
        reason: issue.code === 'unrecognized_keys' ? 'unknown field' : reasonOf(issue, root, path, kind),
      }
    })
  })
}
