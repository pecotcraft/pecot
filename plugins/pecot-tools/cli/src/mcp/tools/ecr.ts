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
  image_tag: z.string().optional().describe('Image tag'),
  image_digest: z.string().optional().describe('Image digest (sha256:... form)'),
})

export function ecrTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: ECR_DESCRIBE_IMAGES,
      title: 'List container images',
      description: 'Returns tags, digests, and push times of images in a repository. Use it to check deploy times. Only ACTIVE images are returned unless specified otherwise',
      inputSchema: z.object({
        repository_name: z.string().describe('Repository name'),
        registry_id: z.string().optional().describe('AWS account ID of the registry (12 digits). If omitted, the default registry'),
        image_ids: z.array(IMAGE_ID_ELEMENT).max(100).optional()
          .describe('Images to get. Each element needs at least one of image_tag and image_digest. Cannot be combined with starting_token'),
        tag_status: z.enum(['TAGGED', 'UNTAGGED', 'ANY']).optional()
          .describe('Filter by whether the image is tagged. If omitted, no filtering'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}
