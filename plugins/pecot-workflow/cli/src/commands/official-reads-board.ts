// board_show が受ける、公式の GitHub MCP の list_project_items の 1 ページ。Draft Issue は番号とリポを持たないので、どの項目も省略できる形にする
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod が推論する結果の型は readonly にできない */
import { z } from 'zod'

import type { ReadCard } from './official-reads.js'
import { referenceOf } from './official-reads.js'
import { issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'

const ITEM_FIELD = z.looseObject({
  id: z.number().int().optional(),
  name: z.string().optional(),
  value: z.unknown().optional(),
})

const ITEM_CONTENT = z.looseObject({
  number: z.number().int().optional(),
  title: z.string().optional(),
  state: z.string().optional(),
  html_url: z.string().optional(),
  repository: z.string().optional(),
  labels: z.array(z.string()).nullable().optional(),
})

const BOARD_ITEM = z.looseObject({
  id: z.number().int(),
  content_type: z.string().optional(),
  content: ITEM_CONTENT.nullable().optional(),
  fields: z.array(ITEM_FIELD).nullable().optional(),
  updated_at: z.string().optional(),
})

/**
projects_list（method: list_project_items）の structuredContent。ページが残るかを pageInfo で見る
*/
const PAGE_INFO = z.looseObject({ hasNextPage: z.boolean() })

export const PROJECT_ITEMS_PAGE = z.looseObject({
  items: z.looseObject({
    items: z.array(BOARD_ITEM).nullable().optional(),
    pageInfo: PAGE_INFO.optional(),
  }),
})

export type ProjectItem = z.infer<typeof BOARD_ITEM>

function valueName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const named = z.looseObject({ name: z.string() }).safeParse(value)
  if (named.success) return named.data.name
  const titled = z.looseObject({ title: z.string() }).safeParse(value)
  return titled.success ? titled.data.title : undefined
}

/**
アイテムの、名前の合う欄（大文字小文字を区別しない）の値の名前。無ければ undefined
*/
export function itemFieldValue(item: ProjectItem, fieldName: string): string | undefined {
  const found = (item.fields ?? []).find(field => field.name?.toLowerCase() === fieldName.toLowerCase())
  return found === undefined ? undefined : valueName(found.value)
}

/**
番号とリポのあるアイテムをカードにする。fields は欄の名前（小文字）→ 値の名前
*/
export function cardOfItem(item: ProjectItem): ReadCard | undefined {
  const { content } = item
  if (content?.number === undefined || content.repository === undefined) return undefined
  const reference = referenceOf(content.repository, content.number)
  if (reference === undefined) return undefined
  const fields = new Map<string, string>()
  const itemFields = item.fields ?? []
  for (const field of itemFields) {
    const name = valueName(field.value)
    if (name !== undefined && field.name !== undefined) fields.set(field.name.toLowerCase(), name)
  }
  return { ref: reference, fields }
}

export function cardsOfItems(items: readonly ProjectItem[]): ReadonlyMap<string, ReadCard> {
  const cards = new Map<string, ReadCard>()
  for (const item of items) {
    const card = cardOfItem(item)
    if (card !== undefined) cards.set(issueReferenceKey(card.ref), card)
  }
  return cards
}
