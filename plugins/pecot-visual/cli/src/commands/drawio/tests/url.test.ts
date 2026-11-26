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

  it('output で親ディレクトリ未作成のパスを指定してもファイルが生成される（接続退行テスト）', async () => {
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

  it('親ディレクトリ未作成でも書き込みが成功する', async () => {
    const dependencies = drawioUrlDefaultDependencies()
    const target = path.join(workDirectory, '.pecotv', 'work', 'drawio', 'test.drawio.html')

    await dependencies.writeFile(target, 'https://example.com\n')

    await expect(readFile(target, 'utf8')).resolves.toBe('https://example.com\n')
  })

  it('親ディレクトリ既存時は従来どおり上書きできる', async () => {
    const dependencies = drawioUrlDefaultDependencies()
    const target = path.join(workDirectory, 'test.drawio.html')

    await dependencies.writeFile(target, 'first\n')
    await dependencies.writeFile(target, 'second\n')

    await expect(readFile(target, 'utf8')).resolves.toBe('second\n')
  })
})
