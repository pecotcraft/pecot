/* eslint-disable security/detect-non-literal-fs-filename -- リポジトリ内の固定パスと mkdtemp の戻り値のみ扱う */
import type { Tool } from '@modelcontextprotocol/client'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { diffGenerated } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { buildGenerated, exportNames, GENERATED_PATH, listTools, repositoryRoot, run, serialize } from '../scripts/export-interface.js'
import { explains } from '../tests/_helpers/explains.js'

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

  it('tools/list から作った内容は、リポジトリの generated.json と一致する', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`tools/list` の結果から組み立てた内容が、コミット済みの `generated.json` の内容と一致することを確認します。')
    expect(serialize(buildGenerated(tools))).toBe(committed)
  })

  it('ツールを 1 つ追加すると、差分の行に entry: added が出力される', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。ツールを 1 つ加えた場合の差分が、追加したツールについて `entry: added` の 1 行だけになることを確認します。')
    const sample = tools[0]
    if (sample === undefined) throw new Error('tools/list が空です')
    const lines = diffGenerated(buildGenerated(tools), buildGenerated([...tools, { ...sample, name: 'aws_sample_tool' }]))
    expect(lines).toEqual(['PT-AWS-SAMPLE-TOOL: entry: added'])
  })

  it('ツールの入力に項目を 1 つ追加すると、差分の行に input.properties.<名前>: added が出力される', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`aws_s3_ls` の入力に `probe` を加えた場合の差分が、`input.properties.probe: added` の 1 行だけになることを確認します。')
    const changed = tools.map(tool => tool.name === 'aws_s3_ls'
      ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, probe: { type: 'string', description: 'Probe' } } } }
      : tool)
    expect(diffGenerated(buildGenerated(tools), buildGenerated(changed))).toEqual(['PT-AWS-S3-LS: input.properties.probe: added'])
  })

  it('ツールの title は mcp.title に反映され、title を変更すると差分の行に mcp.title が出力される', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`aws_s3_ls` の `title` が `mcp.title` と一致し、`title` を変更した場合の差分が、変更前と変更後の値を示す `mcp.title` の 1 行だけになることを確認します。')
    const changed = tools.map(tool => tool.name === 'aws_s3_ls' ? { ...tool, title: 'Probe title' } : tool)
    expect(buildGenerated(tools).entries.find(entry => entry.name === 'aws_s3_ls')?.mcp?.title).toBe(tools.find(tool => tool.name === 'aws_s3_ls')?.title)
    expect(diffGenerated(buildGenerated(tools), buildGenerated(changed))).toEqual([`PT-AWS-S3-LS: mcp.title: ${JSON.stringify(tools.find(tool => tool.name === 'aws_s3_ls')?.title)} -> "Probe title"`])
  })

  it('legacy と modern のどちらのプロトコルでも、同じ内容を書き出す', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`modern` の世代で取得したツールの一覧から作った内容が、`legacy` の世代の内容とバイト列まで一致することを確認します。')
    const modernTools = await listTools('modern')

    expect(serialize(buildGenerated(modernTools))).toBe(serialize(buildGenerated(tools)))
  })

  it('names は区切りが _ で、aws とサービスの後ろに任意の語を許可し、どのツール名もサービスが語彙に存在する', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`names` の区切りが `_` で、先頭の語が `aws`、後ろの語を許可する設定であり、すべてのツール名の 2 番目の語が語彙のサービスに含まれることを確認します。')
    const names = exportNames()
    expect({ separator: names.separator, rest: names.rest, first: names.positions[0]?.map(item => item.word) }).toEqual({ separator: '_', rest: true, first: ['aws'] })
    const services = new Set(names.positions[1]?.map(item => item.word))
    const outside = tools.map(tool => tool.name).filter(name => !name.startsWith('aws_') || !services.has(name.split('_', 2)[1] ?? ''))
    expect(outside).toEqual([])
  })

  it('語彙に語を追加すると、差分の行に names の欄のパスが出力される', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。サービスの語彙に `iam` を加えた場合の差分が、`names.positions[1][…]: added` の 1 行だけになることを確認します。')
    const before = buildGenerated(tools)
    const services = before.names.positions[1] ?? []
    const after = { ...before, names: { ...before.names, positions: [before.names.positions[0] ?? [], [...services, { word: 'iam', meaning: 'AWS IAM' }]] } }
    expect(diffGenerated(before, after)).toEqual([`file: names.positions[1][${String(services.length)}]: added`])
  })

  it('書き出した内容は、generatedFileSchema の検証を通る', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。作成した内容を `generatedFileSchema` で検証した場合に、成功することを確認します。')
    expect(generatedFileSchema.safeParse(buildGenerated(tools)).success).toBe(true)
  })

  it('--check と --write 以外の引数を渡すと、使い方の行を出力して終了コード 2 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。引数なし、未知の引数、`--check` と `--write` の同時指定の場合に、標準エラー出力へ使い方を出力し、終了コードが `2` になることを確認します。')
    for (const argv of [[], ['--other'], ['--check', '--write']]) {
      const result = await capture(argv)
      expect(result).toEqual({ code: 2, stdout: '', stderr: 'usage: export-interface (--check | --write)\n' })
    }
  })

  it('--check は、リポジトリのファイルと一致しているときは、何も出力せず終了コード 0 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。`--check` を実行した場合に、終了コードが `0` で、標準出力と標準エラー出力が空であることを確認します。')
    expect(await capture(['--check'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--check は、古いファイルに対して、終了コード 1 で error、差分、実行すべきコマンドの 3 行を出力する', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。先頭のツールを欠いた古いファイルを対象に `--check` を実行した場合に、終了コードが `1` で、標準エラー出力が `error`、差分、`run` の 3 行になることを確認します。')
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

  it('--check は、ファイルが存在しないときは、error と run の 2 行を出力して終了コード 1 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。存在しないファイルを対象に `--check` を実行した場合に、終了コードが `1` で、標準エラー出力が `cannot read … ENOENT` と `run` の 2 行になることを確認します。')
    const target = path.join(temporaryRoot, 'missing.json')

    const result = await capture(['--check'], { target })

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: cannot read ${target}: ENOENT\n  run: ${WRITE_COMMAND}\n` })
  })

  it('--check は、JSON として解析できないときは、error と run の 2 行を出力して終了コード 1 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。内容が `{` だけのファイルを対象に `--check` を実行した場合に、終了コードが `1` で、標準エラー出力が `error: cannot read` で始まり、`run` の行で終わることを確認します。')
    const target = path.join(temporaryRoot, 'broken.json')
    writeFileSync(target, '{')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stderr.startsWith(`error: cannot read ${target}: `)).toBe(true)
    expect(result.stderr.endsWith(`
  run: ${WRITE_COMMAND}
`)).toBe(true)
  })

  it('--check は、形式に合わないときは、error と run の 2 行を出力して終了コード 1 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。形式に合わない内容のファイルを対象に `--check` を実行した場合に、終了コードが `1` で、標準エラー出力が `error: cannot read` で始まり、`run` の行で終わることを確認します。')
    const target = path.join(temporaryRoot, 'invalid.json')
    writeFileSync(target, '{"format": 2}\n')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stderr.startsWith(`error: cannot read ${target}: `)).toBe(true)
    expect(result.stderr.endsWith(`
  run: ${WRITE_COMMAND}
`)).toBe(true)
  })

  it('--write で書き出したファイルは、--check で一致と判定される', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。存在しないディレクトリを含むパスへ `--write` で書き出した場合は、`wrote:` の行を出力して終了コード `0` で終わり、`--check` も成功することを確認します。')
    const target = path.join(temporaryRoot, 'nested', 'generated.json')

    const written = await capture(['--write'], { target })

    expect(written).toEqual({ code: 0, stdout: `wrote: ${target}\n`, stderr: '' })
    expect(readFileSync(target, 'utf8')).toBe(committed)
    expect(await capture(['--check'], { target })).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--write が失敗したときは、error: cannot write の行を出力して終了コード 1 で終わる', async () => {
    await explains('ツールの一覧から `interface/generated.json` を書き出す仕組みのテストです。ファイルを親のディレクトリとして指定して `--write` を実行した場合は、終了コードが `1` で、標準エラー出力が `error: cannot write` で始まることを確認します。')
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
