// ECR 系のツール定義。
//
// tag_status は awscli の `--filter tagStatus=<値>` へ合成する（許可リスト側の shorthand）。
// 利用者に shorthand の文字列そのものを書かせないのは Athena と同じ理由。

import { z } from 'zod'

import { ECR_DESCRIBE_IMAGES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
取得するイメージの指定 1 件。タグとダイジェストのどちらか一方だけでも指定できる。

`z.object` は宣言外のキーを通知せず削るため strictObject を使う。
JSON Schema では `items.additionalProperties: false` になり、SDK が入力検証エラーで拒否する。
*/
const IMAGE_ID_ELEMENT = z.strictObject({
  image_tag: z.string().optional().describe('イメージタグ'),
  image_digest: z.string().optional().describe('イメージダイジェスト（sha256:… の形式）'),
})

export function ecrTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: ECR_DESCRIBE_IMAGES,
      title: 'コンテナイメージの一覧',
      description: 'リポジトリ内のイメージのタグ・ダイジェスト・push 時刻を返す。デプロイ時刻の確認に使う。未指定時は ACTIVE のイメージのみが返る',
      inputSchema: z.object({
        repository_name: z.string().describe('リポジトリ名'),
        registry_id: z.string().optional().describe('レジストリの AWS アカウント ID（12 桁）。未指定なら既定のレジストリ'),
        image_ids: z.array(IMAGE_ID_ELEMENT).max(100).optional()
          .describe('取得するイメージの指定。要素ごとに image_tag と image_digest の少なくとも一方が必要。starting_token とは併用できない'),
        tag_status: z.enum(['TAGGED', 'UNTAGGED', 'ANY']).optional()
          .describe('タグの有無で絞り込む。未指定なら絞り込まない'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}
