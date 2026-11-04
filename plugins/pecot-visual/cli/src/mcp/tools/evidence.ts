// evidence 系の MCP ツール定義 (evidence_create)。
//
// ハンドラは既存 CLI と同じ executeEvidenceCreate を呼ぶ。CLI の `--json` が出す
// オブジェクトをそのまま ToolResult.data に載せるため、CLI と MCP の結果は同形になる。

import path from 'node:path'

import { z } from 'zod'

import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  errorData,
  EVIDENCE_CREATE_FAILURE_EXIT_CODE,
  evidenceCreateDefaultDependencies,
  executeEvidenceCreate,
  type EvidenceCreateDependencies,
} from '../../commands/evidence-xlsx/create.js'
import { parsePathArguments, toCallToolResult } from '../result.js'
import type { ToolDefinition } from '../server.js'
import { captureCommandOutput, formatError, textViolationMessage, TOOL_OUTPUT_SCHEMA, violationCountOf, WINDOWS_PATH_NOTE } from './_shared.js'

const evidenceCreateInput = z.object({
  input_path: z.string().describe('EvidenceSpec JSON の絶対パス。' + WINDOWS_PATH_NOTE),
  out_path: z.string().optional().describe(
    '出力する xlsx の絶対パス。省略時は input_path と同じディレクトリの evidence.xlsx。' + WINDOWS_PATH_NOTE,
  ),
})

/**
out_path 省略時の既定。

CLI の既定 `./evidence.xlsx` は cwd 依存で、MCP サーバの cwd はクライアントの cwd と
一致する保証が無い (FR-011 が相対パスを弾く理由と同じ)。input_path と同じディレクトリに置く。
*/
function defaultOutPath(inputPath: string): string {
  return path.join(path.dirname(inputPath), 'evidence.xlsx')
}

async function handleEvidenceCreate(
  arguments_: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  const validated = parsePathArguments(evidenceCreateInput, arguments_, ['input_path', 'out_path'])
  if (validated.rejected !== undefined) return toCallToolResult(validated.rejected)
  const input = validated.input

  const output = captureCommandOutput()

  try {
    // deps はハンドラ内で毎回生成する。既定 deps ファクトリを module top-level で評価すると
    // 環境変数に依存するツール (slide 系) と横並びで失敗しうるため、生成時点をここに統一する。
    const dependencies: EvidenceCreateDependencies = {
      ...evidenceCreateDefaultDependencies(),
      stdout: output.stdout,
      stderr: output.stderr,
    }
    const data = await executeEvidenceCreate(
      { input: input.input_path, out: input.out_path ?? defaultOutPath(input.input_path) },
      dependencies,
    )
    const counts = `項目 ${String(data.items)} 件 / 注記 ${String(data.annotations)} 件 / 除外 ${String(data.skipped.length)} 件`
    return toCallToolResult({
      ok: true,
      exitCode: 0,
      artifacts: [data.outPath],
      data: { ...data },
      message: `エビデンス xlsx を生成しました: ${data.outPath} (${counts})`,
      ...output.part(),
    })
  }
  catch (error: unknown) {
    const data = errorData(error)
    const violationCount = violationCountOf(data)
    return toCallToolResult({
      ok: false,
      // usage エラー (exit 2) は commander の引数検証にしか無い。MCP では
      // inputSchema と parsePathArguments が先に弾くため、ここは実行失敗の 1 のみ。
      exitCode: EVIDENCE_CREATE_FAILURE_EXIT_CODE,
      artifacts: [],
      data,
      message: violationCount === undefined ? formatError(error) : textViolationMessage(violationCount),
      ...output.part(),
    })
  }
}

export const evidenceCreateTool: ToolDefinition = {
  name: 'evidence_create',
  config: {
    title: 'エビデンス xlsx 生成',
    description:
      'EvidenceSpec JSON からスクリーンショット貼り付け済みの作業エビデンス xlsx を生成する。'
      + ' spec に列挙した画像を順に配置し、注記を添える。'
      + ' 生成前に title・caption・注記の文言を文章規則で確認し、違反があれば生成しない。',
    inputSchema: evidenceCreateInput,
    outputSchema: TOOL_OUTPUT_SCHEMA,
    // ローカルの spec / 画像を読んで xlsx を書くだけでネットワークには到達しない。
    annotations: { openWorldHint: false },
  },
  handler: handleEvidenceCreate,
}
