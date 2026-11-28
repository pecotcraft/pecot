// release_check・workflow_install・workflow_doctor が受ける読み取りの形。alert の一覧・リリース・commit・github-ops の workflow-doctor。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod が推論する結果の型は readonly にできない */
import { z } from 'zod'

import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import type { SettingList, SettingNames } from '@pecot/workflow-core/domain/workflow-template.js'

const PAGE_INFO = z.looseObject({ hasNextPage: z.boolean().optional() })

const ALERT_LIST = z.array(z.json())

export const ALERT_PAGE = z.union([
  z.looseObject({ alerts: ALERT_LIST.nullable().optional(), pageInfo: PAGE_INFO.optional() }),
  ALERT_LIST,
])

/**
alert の一覧 1 種を読んだ結果。読めたページか、公式のツールが返した誤りの文
*/
export const ALERT_READ = z.object({
  pages: z.array(z.unknown()).optional().describe('Results of the list tool with state open, every page'),
  error: z.string().optional().describe('The error text the list tool returned instead of a result (such as the feature being disabled)'),
})

export type AlertRead = z.infer<typeof ALERT_READ>

/**
list_*_alerts の 1 ページの alert と、続きのページの有無。v2.3.0 より前の平らな配列も受ける
*/
export function alertPageOf(page: z.infer<typeof ALERT_PAGE>): { readonly alerts: readonly JsonValue[], readonly hasNextPage: boolean } {
  return Array.isArray(page) ? { alerts: page, hasNextPage: false } : { alerts: page.alerts ?? [], hasNextPage: page.pageInfo?.hasNextPage === true }
}

/**
get_release_by_tag の結果。読めたら release、誤りなら error
*/
export const RELEASE_READ = z.object({
  result: z.unknown().optional().describe('Result of get_release_by_tag for the tag'),
  error: z.string().optional().describe('The error text get_release_by_tag returned (404 when the tag has no release)'),
})

export const RELEASE = z.looseObject({ tag_name: z.string(), html_url: z.string().optional() })

/**
get_commit の結果。sha は、渡した ref が指す commit
*/
export const COMMIT = z.looseObject({ sha: z.string().regex(/^[\da-f]{40}$/u) })

const SETTING_LIST = z.looseObject({ names: z.array(z.string()), complete: z.boolean() })

const DOCTOR_RESULT = z.looseObject({ secrets: SETTING_LIST, variables: SETTING_LIST })

// github-ops の workflow-doctor の結果。PECOT_RESULT の行の JSON か、その result
const OK_READ = z.looseObject({ ok: z.literal(true), result: DOCTOR_RESULT })

const FAILED_READ = z.looseObject({ ok: z.literal(false) })

const UNREAD: SettingList = { names: new Set(), complete: false }

function settingListOf(list: z.infer<typeof SETTING_LIST>): SettingList {
  return { names: new Set(list.names), complete: list.complete }
}

/**
読んだ secret と variable の名前。無いか失敗なら、どちらも未読（complete: false）。workflow-doctor の結果の形でなければ undefined
*/
export function settingNamesOf(read: unknown): SettingNames | undefined {
  if (read === undefined || FAILED_READ.safeParse(read).success) return { secrets: UNREAD, variables: UNREAD }
  const ok = OK_READ.safeParse(read)
  const result = DOCTOR_RESULT.safeParse(ok.success ? ok.data.result : read)
  return result.success ? { secrets: settingListOf(result.data.secrets), variables: settingListOf(result.data.variables) } : undefined
}
