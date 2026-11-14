/* eslint-disable security/detect-non-literal-fs-filename -- リポジトリ内の固定パスと mkdtemp の戻り値のみ扱う */
import type { Tool } from '@modelcontextprotocol/client'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { diffGenerated } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { buildGenerated, exportNames, GENERATED_PATH, listTools, repositoryRoot, run, serialize } from '../scripts/export-interface.js'

async function capture(argv: readonly string[], options: Parameters<typeof run>[2] = {}): Promise<{ code: number, stdout: string, stderr: string }> {
  const out = { stdout: '', stderr: '' }
  const code = await run(argv, {
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  }, options)
  return { code, ...out }
}

const WRITE_COMMAND = 'pnpm --dir plugins/pecot-tools/cli exec tsx scripts/export-interface.ts --write'

describe('generated.json の書き出し', () => {
  let committed = ''
  let tools: readonly Tool[] = []
  let temporaryRoot = ''

  beforeAll(async () => {
    committed = readFileSync(path.join(repositoryRoot(), GENERATED_PATH), 'utf8')
    tools = await listTools()
    temporaryRoot = mkdtempSync(path.join(tmpdir(), 'pecot-tools-export-'))
  })

  afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('tools/list から作った内容がリポジトリのファイルと一致する', () => {
    expect(serialize(buildGenerated(tools))).toBe(committed)
  })

  it('ツールを 1 つ足すと差の行に entry: added が出る', () => {
    const sample = tools[0]
    if (sample === undefined) throw new Error('tools/list が空です')
    const lines = diffGenerated(buildGenerated(tools), buildGenerated([...tools, { ...sample, name: 'aws_sample_tool' }]))
    expect(lines).toEqual(['PT-AWS-SAMPLE-TOOL: entry: added'])
  })

  it('入力に項目を 1 つ足すと差の行に input.properties.<名前>: added が出る', () => {
    const changed = tools.map(tool => tool.name === 'aws_s3_ls'
      ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, probe: { type: 'string', description: 'Probe' } } } }
      : tool)
    expect(diffGenerated(buildGenerated(tools), buildGenerated(changed))).toEqual(['PT-AWS-S3-LS: input.properties.probe: added'])
  })

  it('legacy と modern の世代で同じバイト列になる', async () => {
    const modernTools = await listTools('modern')

    expect(serialize(buildGenerated(modernTools))).toBe(serialize(buildGenerated(tools)))
  })

  it('names は区切りが _ で、aws とサービスの後ろに自由な語を許し、どのツール名もサービスが語彙にある', () => {
    const names = exportNames()
    expect({ separator: names.separator, rest: names.rest, first: names.positions[0]?.map(item => item.word) }).toEqual({ separator: '_', rest: true, first: ['aws'] })
    const services = new Set(names.positions[1]?.map(item => item.word))
    const outside = tools.map(tool => tool.name).filter(name => !name.startsWith('aws_') || !services.has(name.split('_', 2)[1] ?? ''))
    expect(outside).toEqual([])
  })

  it('語彙に語を足すと差の行に names の欄のパスが出る', () => {
    const before = buildGenerated(tools)
    const services = before.names.positions[1] ?? []
    const after = { ...before, names: { ...before.names, positions: [before.names.positions[0] ?? [], [...services, { word: 'iam', meaning: 'AWS IAM' }]] } }
    expect(diffGenerated(before, after)).toEqual([`file: names.positions[1][${String(services.length)}]: added`])
  })

  it('書き出しが generatedFileSchema を通る', () => {
    expect(generatedFileSchema.safeParse(buildGenerated(tools)).success).toBe(true)
  })

  it('--check と --write 以外の引数は使い方の行と終了コード 2', async () => {
    for (const argv of [[], ['--other'], ['--check', '--write']]) {
      const result = await capture(argv)
      expect(result).toEqual({ code: 2, stdout: '', stderr: 'usage: export-interface (--check | --write)\n' })
    }
  })

  it('--check はリポジトリのファイルと一致していれば何も出さず終了コード 0', async () => {
    expect(await capture(['--check'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--check は古いファイルに対して終了コード 1 と error・差・run の 3 行を出す', async () => {
    const target = path.join(temporaryRoot, 'stale.json')
    const rest = buildGenerated(tools.slice(1))
    writeFileSync(target, serialize(rest))
    const first = tools[0]
    if (first === undefined) throw new Error('tools/list が空です')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe([
      `error: ${target} is stale`,
      `  PT-${first.name.toUpperCase().replaceAll('_', '-')}: entry: added`,
      `  run: ${WRITE_COMMAND}`,
      '',
    ].join('\n'))
  })

  it('--check はファイルが無いとき error と run の 2 行で終了コード 1', async () => {
    const target = path.join(temporaryRoot, 'missing.json')

    const result = await capture(['--check'], { target })

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: cannot read ${target}: ENOENT\n  run: ${WRITE_COMMAND}\n` })
  })

  it('--check は JSON として読めないとき error と run の 2 行で終了コード 1', async () => {
    const target = path.join(temporaryRoot, 'broken.json')
    writeFileSync(target, '{')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stderr.startsWith(`error: cannot read ${target}: `)).toBe(true)
    expect(result.stderr.endsWith(`
  run: ${WRITE_COMMAND}
`)).toBe(true)
  })

  it('--check は形式に合わないとき error と run の 2 行で終了コード 1', async () => {
    const target = path.join(temporaryRoot, 'invalid.json')
    writeFileSync(target, '{"format": 2}\n')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stderr.startsWith(`error: cannot read ${target}: `)).toBe(true)
    expect(result.stderr.endsWith(`
  run: ${WRITE_COMMAND}
`)).toBe(true)
  })

  it('--write で書いたファイルは --check と一致する', async () => {
    const target = path.join(temporaryRoot, 'nested', 'generated.json')

    const written = await capture(['--write'], { target })

    expect(written).toEqual({ code: 0, stdout: `wrote: ${target}\n`, stderr: '' })
    expect(readFileSync(target, 'utf8')).toBe(committed)
    expect(await capture(['--check'], { target })).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--write の失敗は error: cannot write の行と終了コード 1', async () => {
    const blocker = path.join(temporaryRoot, 'blocker')
    writeFileSync(blocker, '')
    const target = path.join(blocker, 'generated.json')

    const result = await capture(['--write'], { target })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(`error: cannot write ${target}: `)).toBe(true)
    expect(/(?:EEXIST|ENOTDIR)\n$/.test(result.stderr)).toBe(true)
  })
})
