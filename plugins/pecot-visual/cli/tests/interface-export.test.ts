/* eslint-disable security/detect-non-literal-fs-filename -- リポジトリ内の固定パスと mkdtemp の戻り値のみ扱う */
import type { Tool } from '@modelcontextprotocol/client'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { diffGenerated } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema } from '../../../../libs/interface-spec/src/domain/schema.js'
import { buildGenerated, exportNames, GENERATED_PATH, listTools, repositoryRoot, run, serialize } from '../scripts/export-interface.js'
import { explains } from './_helpers/explains.js'

async function capture(argv: readonly string[], options: Parameters<typeof run>[2] = {}): Promise<{ code: number, stdout: string, stderr: string }> {
  const out = { stdout: '', stderr: '' }
  const code = await run(argv, {
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  }, options)
  return { code, ...out }
}

const WRITE_COMMAND = 'pnpm --dir plugins/pecot-visual/cli exec tsx scripts/export-interface.ts --write'

describe('generated.json の書き出し', () => {
  let committed = ''
  let tools: readonly Tool[] = []
  let temporaryRoot = ''

  beforeAll(async () => {
    committed = readFileSync(path.join(repositoryRoot(), GENERATED_PATH), 'utf8')
    tools = await listTools()
    temporaryRoot = mkdtempSync(path.join(tmpdir(), 'pecot-visual-export-'))
  })

  afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('MCP の tools/list から作成した内容が、リポジトリの generated.json と一致する', async () => {
    await explains('`generated.json` の書き出しのテストです。MCP の `tools/list` から作成した内容を `serialize` した場合に、リポジトリに置いたファイルと一致することを確認します。')
    expect(serialize(buildGenerated(tools))).toBe(committed)
  })

  it('ツールを 1 つ追加すると、差分の行に entry: added が出力される', async () => {
    await explains('差分のテストです。`tools/list` の結果へ `slide_lint_sample` を追加した場合に、差分が `PV-SLIDE-LINT-SAMPLE: entry: added` の 1 行になることを確認します。')
    const sample = tools[0]
    if (sample === undefined) throw new Error('tools/list が空です')
    const lines = diffGenerated(buildGenerated(tools), buildGenerated([...tools, { ...sample, name: 'slide_lint_sample' }]))
    expect(lines).toEqual(['PV-SLIDE-LINT-SAMPLE: entry: added'])
  })

  it('入力に項目を 1 つ追加すると、差分の行に input.properties.<名前>: added が出力される', async () => {
    await explains('差分のテストです。`slide_theme` の入力へ `probe` を追加した場合に、差分が `PV-SLIDE-THEME: input.properties.probe: added` の 1 行になることを確認します。')
    const changed = tools.map(tool => tool.name === 'slide_theme'
      ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, probe: { type: 'string', description: 'Probe' } } } }
      : tool)
    expect(diffGenerated(buildGenerated(tools), buildGenerated(changed))).toEqual(['PV-SLIDE-THEME: input.properties.probe: added'])
  })

  it('ツールの title は mcp.title に書き出され、変更すると差分の行に mcp.title が出力される', async () => {
    await explains('`title` の書き出しのテストです。`slide_theme` の `title` が `mcp.title` と一致し、`title` を変更した場合に、差分の行が変更前と変更後の値を含む `mcp.title` の 1 行になることを確認します。')
    const changed = tools.map(tool => tool.name === 'slide_theme' ? { ...tool, title: 'Probe title' } : tool)
    expect(buildGenerated(tools).entries.find(entry => entry.name === 'slide_theme')?.mcp?.title).toBe(tools.find(tool => tool.name === 'slide_theme')?.title)
    expect(diffGenerated(buildGenerated(tools), buildGenerated(changed))).toEqual([`PV-SLIDE-THEME: mcp.title: ${JSON.stringify(tools.find(tool => tool.name === 'slide_theme')?.title)} -> "Probe title"`])
  })

  it('legacy と modern のどちらの世代で取得しても、同じバイト列を書き出す', async () => {
    await explains('MCP の世代による差のテストです。`legacy` と `modern` の世代でそれぞれ `tools/list` を取得した場合に、書き出す内容が一致することを確認します。')
    const modernTools = await listTools('modern')

    expect(serialize(buildGenerated(modernTools))).toBe(serialize(buildGenerated(tools)))
  })

  it('names の区切りは _ の 2 語で、すべてのツール名が語彙の語で構成される', async () => {
    await explains('`names` の語彙のテストです。区切りが `_` で 2 語であり、1 語目が `drawio`・`evidence`・`slide`・`runtime` になり、すべてのツール名の各語が語彙に含まれることを確認します。')
    const names = exportNames()
    expect({ separator: names.separator, rest: names.rest, count: names.positions.length }).toEqual({ separator: '_', rest: false, count: 2 })
    expect(names.positions[0]?.map(item => item.word)).toEqual(['drawio', 'evidence', 'slide', 'runtime', 'file'])
    const words = names.positions.map(position => new Set(position.map(item => item.word)))
    const outside = tools.map(tool => tool.name).filter(name => name.split('_').some((word, index) => words.at(index)?.has(word) !== true))
    expect(outside).toEqual([])
  })

  it('語彙に語を追加すると、差分の行に names の欄のパスが出力される', async () => {
    await explains('語彙の差分の検出のテストです。`names.positions` へ `extra` を含む語の欄を追加した場合に、差分の行が `file: names.positions[2]: added` になることを確認します。')
    const before = buildGenerated(tools)
    const after = { ...before, names: { ...before.names, positions: [...before.names.positions, [{ word: 'extra', meaning: 'Extra' }]] } }
    expect(diffGenerated(before, after)).toEqual(['file: names.positions[2]: added'])
  })

  it('書き出した内容が、generatedFileSchema の検証を通る', async () => {
    await explains('書き出しの形式のテストです。`tools/list` から作成した内容を `generatedFileSchema` で検証した場合に、成功することを確認します。')
    expect(generatedFileSchema.safeParse(buildGenerated(tools)).success).toBe(true)
  })

  it('--check と --write 以外の引数を指定すると、使い方の行を出力し、終了コード 2 で終わる', async () => {
    await explains('引数の検証のテストです。引数なしなどの場合に、終了コードが 2 になり、標準エラーへ `usage: export-interface (--check | --write)` が出力されることを確認します。')
    for (const argv of [[], ['--other'], ['--check', '--write']]) {
      const result = await capture(argv)
      expect(result).toEqual({ code: 2, stdout: '', stderr: 'usage: export-interface (--check | --write)\n' })
    }
  })

  it('--check は、リポジトリのファイルと一致していれば、何も出力せず終了コード 0 で終わる', async () => {
    await explains('`--check` の一致時のテストです。リポジトリの `generated.json` に対して実行した場合に、終了コードが 0 で、標準出力と標準エラーが空であることを確認します。')
    expect(await capture(['--check'])).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--check は、古いファイルに対して、error・差分・run の 3 行を出力し、終了コード 1 で終わる', async () => {
    await explains('`--check` の不一致時のテストです。ツールを 1 つ欠いたファイルに対して実行した場合に、終了コードが 1 になり、標準エラーに `is stale` の行、差分の行、再生成のコマンドの行が出力されることを確認します。')
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
      `  PV-${first.name.toUpperCase().replaceAll('_', '-')}: entry: added`,
      `  run: ${WRITE_COMMAND}`,
      '',
    ].join('\n'))
  })

  it('--check は、ファイルが存在しない場合に、error と run の 2 行を出力し、終了コード 1 で終わる', async () => {
    await explains('`--check` の対象のファイルがない場合のテストです。存在しないパスを指定した場合に、終了コードが 1 になり、標準エラーに `ENOENT` を含む `error` の行と再生成のコマンドの行が出力されることを確認します。')
    const target = path.join(temporaryRoot, 'missing.json')

    const result = await capture(['--check'], { target })

    expect(result).toEqual({ code: 1, stdout: '', stderr: `error: cannot read ${target}: ENOENT\n  run: ${WRITE_COMMAND}\n` })
  })

  it('--check は、JSON として読めない場合に、error と run の 2 行を出力し、終了コード 1 で終わる', async () => {
    await explains('`--check` の対象が JSON でない場合のテストです。内容が `{` だけのファイルを指定した場合に、終了コードが 1 になり、`error: cannot read` の行と再生成のコマンドの行が出力されることを確認します。')
    const target = path.join(temporaryRoot, 'broken.json')
    writeFileSync(target, '{')

    const result = await capture(['--check'], { target })

    expect(result.code).toBe(1)
    expect(result.stderr.startsWith(`error: cannot read ${target}: `)).toBe(true)
    expect(result.stderr.endsWith(`
  run: ${WRITE_COMMAND}
`)).toBe(true)
  })

  it('--check は、形式が不正な場合は、error と run の 2 行を出力し、終了コード 1 で終わる', async () => {
    await explains('`--check` の対象の形式が不正な場合のテストです。`{"format": 2}` のファイルを指定した場合に、終了コードが 1 になり、`error: cannot read` の行と再生成のコマンドの行が出力されることを確認します。')
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
    await explains('`--write` と `--check` の整合のテストです。存在しないディレクトリの下へ `--write` した場合に、`wrote:` の行が出力され、内容がリポジトリのファイルと一致し、同じファイルへの `--check` が成功することを確認します。')
    const target = path.join(temporaryRoot, 'nested', 'generated.json')

    const written = await capture(['--write'], { target })

    expect(written).toEqual({ code: 0, stdout: `wrote: ${target}\n`, stderr: '' })
    expect(readFileSync(target, 'utf8')).toBe(committed)
    expect(await capture(['--check'], { target })).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('--write が失敗すると、error: cannot write の行を出力し、終了コード 1 で終わる', async () => {
    await explains('`--write` の失敗時のテストです。ファイルの下を出力先にした場合は、終了コードが 1 になり、標準エラーへ `error: cannot write` で始まり `EEXIST` か `ENOTDIR` で終わる行が出力されることを確認します。')
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
