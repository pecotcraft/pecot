// STS 系のツール定義。

import { z } from 'zod'

import { STS_GET_CALLER_IDENTITY } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import { allowlistedTool, COMMON_INPUT_SHAPE, type ToolOptions } from './_shared.js'

export function stsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: STS_GET_CALLER_IDENTITY,
      title: '呼び出し元 ID の確認',
      description: '現在の認証情報が示すアカウント ID・ユーザ ID・ARN を返す。認証が通っているかの確認に使う',
      inputSchema: z.object({ ...COMMON_INPUT_SHAPE }),
    }, options),
  ]
}
