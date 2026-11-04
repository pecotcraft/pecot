// slide_theme ツール。talk-dir が参照するテーマの宣言とレイアウトの一覧を返す。
//
// 対応する CLI は `pecotv slide theme`。実処理と `--json` の data 組み立ては
// commands/slidev-project/theme.ts の executeSlideTheme が持つ単一実装を共有する。
// ここに置くのは引数の写像と ToolResult への正規化だけ。
// 読み取りだけで、ネットワークには出ない。

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  errorToReason,
  executeSlideTheme,
  slideThemeDefaultDependencies,
} from '../../commands/slidev-project/theme.js'
import type { SlideThemeDependencies } from '../../commands/slidev-project/theme.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { ToolDefinition } from '../server.js'
import { formatError, TOOL_OUTPUT_SCHEMA, WINDOWS_PATH_NOTE } from './_shared.js'

/**
解決・宣言の失敗の exit code（各コマンドの RuntimeError と同じ 1）。
*/
const SLIDE_THEME_EXIT_CODE = 1

const slideThemeInput = z.object({
  dir: z.string()
    .describe('テーマを調べる talk-dir の絶対パス。相対パスは受け付けない。' + WINDOWS_PATH_NOTE),
})

/**
`pecotv slide theme` 相当。
`theme`（名前・指定・宣言の有無・root）、`declaration`、`layouts`、`categories`、`lint`、`warnings` を返す。
*/
export function slideThemeTool(
  buildDependencies: () => SlideThemeDependencies = slideThemeDefaultDependencies,
): ToolDefinition {
  return {
    name: 'slide_theme',
    config: {
      title: 'Slidev テーマの宣言',
      description: 'talk-dir が参照するテーマの宣言とレイアウトの一覧を返す。'
        + '宣言は書体・文字サイズ・PPTX の書体とリンク色・lint の規則。'
        + 'スキルがテーマの値を得るのに使う。',
      inputSchema: slideThemeInput,
      outputSchema: TOOL_OUTPUT_SCHEMA,
      // 読み取りのみで何も書き換えず、ネットワークにも到達しない。
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
      const validated = parsePathArguments(slideThemeInput, arguments_, ['dir'])
      if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
      const { dir } = validated.input

      try {
        const { data } = await executeSlideTheme({ dir }, buildDependencies())
        return toCallToolResult({
          ok: true,
          exitCode: 0,
          artifacts: [],
          data: { ...data },
          message: `slide theme: ${data.theme.name}（レイアウト ${String(data.layouts.length)} 件）`,
        })
      }
      catch (error: unknown) {
        const detail = formatError(error)
        return toCallToolResult({
          ok: false,
          exitCode: SLIDE_THEME_EXIT_CODE,
          artifacts: [],
          data: { event: 'slide.theme.error', reason: errorToReason(error), detail },
          message: detail,
        })
      }
    },
  }
}
