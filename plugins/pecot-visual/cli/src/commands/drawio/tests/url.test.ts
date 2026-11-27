// commands/drawio/url.ts の defaultDeps.writeFile が出力先の親ディレクトリを補完することを pin する。
// 出力先は利用検知 hook が作る前提。
// hook が動かない環境では `.pecotv/work/drawio/` が存在しない。
// 補完が無いと drawio_url の出力が output-write-failed になる（#662）。

/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drawioUrlDefaultDependencies, executeDrawioUrl } from '../url.js'
import { explains } from '../../../../tests/_helpers/explains.js'

// executeDrawioUrl + 既定の依存の接続退行を検知する（F-08）。
// PNG キャプチャ（playwright）は png: false で省略する。
describe('executeDrawioUrl (integration)', () => {
  let workDirectory: string

  beforeEach(async () => {
    workDirectory = await mkdtemp(path.join(tmpdir(), 'pecotv-url-integration-test-'))
  })

  afterEach(async () => {
    await rm(workDirectory, { recursive: true, force: true })
  })

  it('output に親ディレクトリが存在しないパスを指定した場合でも、出力ファイルを作成する', async () => {
    await explains('draw.io の表示用 HTML を出力する `executeDrawioUrl` を、既定の依存関係のまま実行するテストです。`output` に親ディレクトリが存在しないパスを指定した場合に、ディレクトリを作成して出力ファイルを書き込み、警告が 0 件であることを確認します。')
    const inputFile = path.resolve(__dirname, '../../../../tests/fixtures/drawio/minimal.drawio')
    const outputFile = path.join(workDirectory, 'nested', 'sub', 'output.drawio.html')

    const execution = await executeDrawioUrl(inputFile, { mode: 'view', png: false, output: outputFile }, drawioUrlDefaultDependencies())

    const written = await stat(outputFile)
    expect(written.isFile()).toBe(true)

    const content = await readFile(outputFile, 'utf8')
    // 表示用 HTML。meta refresh と可視リンクの 2 箇所に https://app.diagrams.net/... が入る
    expect(content.startsWith('<!doctype html>\n')).toBe(true)
    expect(content).toContain('<meta http-equiv="refresh" content="0;url=https://app.diagrams.net/')
    expect(content).toContain('<a id="target" href="https://app.diagrams.net/')

    // 警告なし
    expect(execution.warningCount).toBe(0)
    expect(execution.artifacts).toStrictEqual([outputFile])
  })
})

describe('drawioUrlDefaultDependencies.writeFile', () => {
  let workDirectory: string

  beforeEach(async () => {
    workDirectory = await mkdtemp(path.join(tmpdir(), 'pecotv-url-test-'))
  })

  afterEach(async () => {
    await rm(workDirectory, { recursive: true, force: true })
  })

  it('親ディレクトリが存在しない場合でも、ファイルの書き込みに成功する', async () => {
    await explains('出力先のファイルを書き込む `drawioUrlDefaultDependencies.writeFile` のテストです。親ディレクトリが存在しない場合でも、ディレクトリを作成して書き込みに成功することを確認します。')
    const dependencies = drawioUrlDefaultDependencies()
    const target = path.join(workDirectory, '.pecotv', 'work', 'drawio', 'test.drawio.html')

    await dependencies.writeFile(target, 'https://example.com\n')

    await expect(readFile(target, 'utf8')).resolves.toBe('https://example.com\n')
  })

  it('親ディレクトリが既に存在する場合は、同じパスのファイルを上書きできる', async () => {
    await explains('出力先のファイルを書き込む `drawioUrlDefaultDependencies.writeFile` のテストです。親ディレクトリが既に存在する場合に、同じパスへ 2 回書き込むと、2 回目の内容で上書きされることを確認します。')
    const dependencies = drawioUrlDefaultDependencies()
    const target = path.join(workDirectory, 'test.drawio.html')

    await dependencies.writeFile(target, 'first\n')
    await dependencies.writeFile(target, 'second\n')

    await expect(readFile(target, 'utf8')).resolves.toBe('second\n')
  })
})
