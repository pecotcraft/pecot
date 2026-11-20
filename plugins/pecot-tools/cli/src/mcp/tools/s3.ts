// S3 系のツール定義。一覧だけを出す。

import { z } from 'zod'

import { S3_LS } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import { allowlistedTool, COMMON_INPUT_SHAPE, type ToolOptions } from './_shared.js'

export function s3Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: S3_LS,
      title: 'List S3 contents',
      description: 'Lists the entries directly under a bucket or prefix. Omit s3_uri to list buckets. The command has no JSON output, so results are returned per line in lines',
      inputSchema: z.object({
        s3_uri: z.string().optional().describe('Target to list (s3://bucket or s3://bucket/prefix/). If omitted, lists buckets'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}
