// board show の出力の形。GitHub を読まない値だけを置き、cli の board_show から辿れるようにする。
import { z } from 'zod'

import { READINESS_JSON } from './readiness-json.js'

// extend は同じ名前のキーを元の位置のまま置き換えるので、キーの並びは readinessJson と同じに保たれる
const BOARD_READINESS_JSON = READINESS_JSON.extend({
  kind: z.enum(['startable', 'stackable', 'blocked', 'unknown']).describe('Readiness judgment (unknown when the prerequisites could not be read)'),
  text: z.string().describe('Readiness as shown in the Readiness column'),
})

const BOARD_CONTENT_JSON = z.strictObject({
  number: z.unknown().optional().describe('Issue or PR number'),
  state: z.unknown().optional().describe('State of the Issue or PR (OPEN etc.)'),
  url: z.unknown().optional().describe('URL of the Issue or PR'),
  labels: z.array(z.string()).optional().describe('Label names'),
  repository: z.string().optional().describe('Repository (owner/repo)'),
})

const BOARD_ITEM_JSON = z.strictObject({
  id: z.unknown().optional().describe('Project item ID'),
  workflow: z.string().nullable().optional().describe('Column (workflow field value) of the item'),
  lane: z.string().nullable().optional().describe('Value of the pecot-lane field (null when the item has none or the board has no pecot-lane field)'),
  title: z.unknown().optional().describe('Title of the Issue or PR'),
  updatedAt: z.unknown().optional().describe('Last update time of the item'),
  content: BOARD_CONTENT_JSON.describe('Issue or PR on the card'),
  readiness: BOARD_READINESS_JSON.nullable().optional().describe('Readiness of a Ready or Blocked Issue (null for other items; omitted when the server does not support issue dependencies)'),
})

const LANE_SUMMARY_JSON = z.strictObject({
  name: z.string().nullable().describe('Value of the pecot-lane field (null for the Issues without a value)'),
  count: z.int().describe('Number of open Issues with this value'),
  startable: z.int().describe('Number of those Issues in Ready whose readiness is startable'),
})

/**
board_show の MCP の data
*/
export const BOARD_SHOW_OUTPUT = z.strictObject({
  board: z.strictObject({
    items: z.array(BOARD_ITEM_JSON).describe('Open items in Backlog, Pending, Blocked, Ready, Active and In Review'),
  }).describe('Board status'),
  lanes: z.array(LANE_SUMMARY_JSON).describe('Open Issues of the board items counted per pecot-lane value, in the order of the field options (values without Issues count 0; Issues without a value come last). Empty when the board has no pecot-lane field'),
  mismatches: z.int().describe('Number of Ready or Blocked Issues whose column or Status may not match the judgment (data only)'),
})
