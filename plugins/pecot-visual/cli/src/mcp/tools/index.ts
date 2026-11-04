// 公開する 11 ツールの集約。系統別 7 ファイルの定義をここで 1 本の配列にまとめ、
// serve.ts が createMcpServer() へ渡す。
//
// 呼び出しごとに配列を組み直すのは、slide 系がツール定義をファクトリ関数で公開しているため。
// 既定 deps ファクトリの評価は各ハンドラ内に閉じている (module top-level では何も評価しない)。
// CLAUDE_PLUGIN_ROOT 未設定でも allTools() と tools/list が成功する、という受け入れ条件はこの構造で満たす。

import type { ToolDefinition } from '../server.js'
import { drawioCreateTool, drawioExportTool } from './drawio.js'
import { evidenceCreateTool } from './evidence.js'
import { setupTool } from './setup.js'
import { slideTools } from './slide.js'
import { slideDevTool } from './slide-dev.js'
import { slidePageTool } from './slide-page.js'
import { slideThemeTool } from './slide-theme.js'

/**
tools/list に公開する 11 ツール。並びはそのまま tools/list の並びになる。
*/
export function allTools(): readonly ToolDefinition[] {
  return [
    ...slideTools(),
    slideDevTool(),
    slidePageTool(),
    slideThemeTool(),
    drawioCreateTool,
    drawioExportTool,
    evidenceCreateTool,
    setupTool(),
  ]
}
