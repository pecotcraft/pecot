// 判定（Readiness）を JSON に出す形。GitHub を読まない値だけを置き、cli の board_show から辿れるようにする。
import { z } from 'zod'

import { JSON_NULL } from '../domain/json-null.js'
import type { Readiness } from '../domain/readiness.js'
import { repositoryFullName } from '../domain/repository-resolver.js'

/**
readinessJson の形。キーの並びは readinessJson と同じにする
*/
export const READINESS_JSON = z.strictObject({
  kind: z.enum(['startable', 'stackable', 'blocked']).describe('Readiness judgment'),
  stackOn: z.strictObject({
    number: z.int().describe('Issue number to stack on'),
    repository: z.string().describe('Repository of that Issue (owner/repo)'),
    branch: z.string().describe('Branch to stack on'),
  }).nullable().describe('Prerequisite to stack on (null unless stackable)'),
  reason: z.string().nullable().describe('Code of the reason for blocked (null unless blocked)'),
  text: z.string().describe('Readiness as shown in the Readiness line'),
})

export type ReadinessJson = z.input<typeof READINESS_JSON>

/**
board show の判定。前提を読めなかった Issue の kind は unknown
*/
export type BoardReadinessJson = Omit<ReadinessJson, 'kind'> & { readonly kind: ReadinessJson['kind'] | 'unknown' }

/**
JSON の出力に使う判定。reason は blocked のときだけの理由のコード、stackOn はスタック先
*/
export function readinessJson(readiness: Readonly<Readiness>, text: string): ReadinessJson {
  const { stackOn } = readiness
  return {
    kind: readiness.kind,
    stackOn: stackOn === undefined ? JSON_NULL : { number: stackOn.issue.number, repository: repositoryFullName(stackOn.issue.repository), branch: stackOn.branch },
    reason: readiness.reason?.code ?? JSON_NULL,
    text,
  }
}
