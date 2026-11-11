import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { diffGenerated } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { buildGenerated, GENERATED_PATH, listTools, repositoryRoot, run, serialize } from '../scripts/export-interface.js'

async function capture(argv: readonly string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const out = { stdout: '', stderr: '' }
  const code = await run(argv, {
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  })
  return { code, ...out }
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
const committed = readFileSync(path.join(repositoryRoot(), GENERATED_PATH), 'utf8')

describe('generated.json の書き出し', () => {
  it('tools/list から作った内容がリポジトリのファイルと一致する', async () => {
    const tools = await listTools()
    expect(serialize(buildGenerated(tools))).toBe(committed)
  })

  it('ツールを 1 つ足すと差の行に entry: added が出る', async () => {
    const tools = await listTools()
    const sample = tools[0]
    if (sample === undefined) throw new Error('tools/list が空です')
    const extra = { ...sample, name: 'aws_sample_tool' }
    const lines = diffGenerated(generatedFileSchema.parse(JSON.parse(committed)), buildGenerated([...tools, extra]))
    expect(lines).toEqual(['PT-AWS-SAMPLE-TOOL: entry: added'])
  })

  it('入力に項目を 1 つ足すと差の行に input.properties.<名前>: added が出る', async () => {
    const tools = await listTools()
    const changed = tools.map(tool => tool.name === 'aws_s3_ls'
      ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, probe: { type: 'string', description: 'Probe' } } } }
      : tool)
    const lines = diffGenerated(generatedFileSchema.parse(JSON.parse(committed)), buildGenerated(changed))
    expect(lines).toEqual(['PT-AWS-S3-LS: input.properties.probe: added'])
  })

  it('legacy と modern の世代で同じバイト列になる', async () => {
    const legacy = serialize(buildGenerated(await listTools('legacy')))
    const modern = serialize(buildGenerated(await listTools('modern')))
    expect(modern).toBe(legacy)
  })

  it('書き出しが generatedFileSchema を通る', async () => {
    const parsed = generatedFileSchema.safeParse(buildGenerated(await listTools()))
    expect(parsed.success).toBe(true)
  })

  it('--check と --write 以外の引数は使い方の行と終了コード 2', async () => {
    for (const argv of [[], ['--other'], ['--check', '--write']]) {
      const result = await capture(argv)
      expect(result).toEqual({ code: 2, stdout: '', stderr: 'usage: export-interface (--check | --write)\n' })
    }
  })

  it('--check は一致していれば何も出さず終了コード 0', async () => {
    expect(await capture(['--check'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})
