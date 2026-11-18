// handler の結果を、tools/list に出すのと同じ JSON Schema（SDK の ajv）で確かめる補助。SDK は失敗の結果を検証しないため、両方をここで見る。
// SDK の CallToolResult と ToolDefinition は readonly の型を持たない。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import type { CallToolResult } from '@modelcontextprotocol/server'

import { standardOutputSchema, toolOutputSchema } from '../../result.js'
import type { ToolDefinition } from '../../server.js'

/**
値が JSON Schema に合わないときの issue の文。合えば空
*/
export async function outputSchemaIssues(schema: Readonly<Record<string, unknown>>, value: unknown): Promise<readonly string[]> {
  const checked = await standardOutputSchema(schema)['~standard'].validate(value)
  return checked.issues === undefined ? [] : checked.issues.map(issue => issue.message)
}

/**
ツールの outputSchema から、tools/list に出す JSON Schema を作る
*/
export function listedOutputSchema(tool: Readonly<ToolDefinition>): Record<string, unknown> {
  const output = tool.config.outputSchema
  if (output === undefined) throw new Error(`${tool.name} が outputSchema を持っていません`)
  return toolOutputSchema(output)
}

/**
structuredContent が、そのツールの outputSchema に合うことを確かめる。失敗の結果は kind と detail の枝で合うことも確かめる
*/
export async function expectDeclaredOutput(tool: Readonly<ToolDefinition>, result: Readonly<CallToolResult>): Promise<void> {
  const structured = result.structuredContent
  if (structured === undefined) throw new Error(`${tool.name} が structuredContent を返していません`)
  const schema = listedOutputSchema(tool)
  const issues = await outputSchemaIssues(schema, structured)
  if (issues.length > 0) throw new Error(`${tool.name} の structuredContent が outputSchema に合いません: ${issues.join('; ')}`)
  if (result.isError !== true) return
  const { anyOf: _branches, ...closed } = schema
  const failureBranch = await outputSchemaIssues({ ...closed, required: ['kind', 'detail'] }, structured)
  if (failureBranch.length > 0) throw new Error(`${tool.name} の失敗の結果が kind と detail を持ちません: ${failureBranch.join('; ')}`)
}

/**
handler が返すたびに expectDeclaredOutput で確かめるツール定義にする
*/
export function withOutputCheck(tool: Readonly<ToolDefinition>): ToolDefinition {
  return {
    ...tool,
    handler: async (arguments_, call, context) => {
      const result = await tool.handler(arguments_, call, context)
      await expectDeclaredOutput(tool, result)
      return result
    },
  }
}
