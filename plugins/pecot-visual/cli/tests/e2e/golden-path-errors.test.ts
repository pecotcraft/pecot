// Phase 2 受け入れ条件のうちエラーパスと Python フリー assertion (strace -f -e execve)。
// いずれも実 slidev build / Chromium を起こさない軽い CUJ なので、1 ファイルに束ねる。
// 重い 3 CUJ は、golden-path-create-convert / golden-path-default-out / golden-path-hyperlink に分かれて並列に動く。
//
// Chromium を要さないため describe の skip は無く、strace 不在環境では該当 it 内で skip する。
//
// timeout 階層は vitest.e2e.config.ts のコメントを基準とする。
// 階層は、it 引数 ≤ testTimeout 660_000 > runPecotv spawnSync 600_000 = cli 内部 SLIDEV_BUILD_TIMEOUT_MS。

/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertCliBuilt, createPecotvRunner, toolCommandOf } from '../_helpers/pecotv-e2e-run.js'
import { isStraceAvailable, parsePythonExecves, runWithoutPython } from '../_helpers/no-python.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { copyFixtureTheme } from '../_helpers/theme-fixtures.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'
import { explains } from '../_helpers/explains.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')

// 本ファイルは軽い CUJ を 5 件束ねるため、他 8 ファイルのようなファイル全体ではなく、it 単位で ceiling を引く。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、最も重い it は 1.83s。
// マージン倍率 4.4 倍は 8.1s なので、9s へ切り上げる。
// 性能目標ではなく、hang regression を SIGTERM kill (600s) より手前で落とすための上限。
const PER_IT_CEILING_MS = durationCeilingMs(9000)

const temporaryRoot = useTemporaryDirectory('pecotv-e2e-errors-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'golden-path/errors',
  // 本ファイルは exit 1 を期待する CUJ を含むため、tail は spawnSync timeout のときだけ出す。
  isUnexpectedExit: status => status === null,
})

/**
最終行の structuredContent から失敗の kind を読む。エラーパスの payload はこの 1 行で完結する。
*/
function lastKind(stdout: string): string {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
  return (JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { kind?: string }).kind ?? ''
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('CUJ 3: エラーパス + Python フリー', () => {
  it('既存のディレクトリへ `--force` なしで `slide create` すると、終了コード 1 で `dest-exists` を返す', async () => {
    await explains('`slide create` の既存のディレクトリの扱いのテストです。作成済みのディレクトリへ `--force` なしでもう一度作成した場合に、終了コードが 1 で、失敗の理由が `dest-exists` になることを確認します。')
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj3-exist')
    // create だけを見る CUJ なので、依存を持たない写し（file:）で足りる。
    const theme = copyFixtureTheme('with-declaration', temporaryRoot('theme-cuj3-exist')).spec
    expect(runPecotv('create', ['slide', 'create', projectDirectory, '--theme', theme]).status).toBe(0)
    const second = runPecotv('create-again', ['slide', 'create', projectDirectory, '--theme', theme, '--json'])
    expect(second.status).toBe(1)
    expect(lastKind(second.stdout)).toBe('dest-exists')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 240_000)

  it('存在しないプロジェクトを `slide convert` に指定すると、終了コード 1 で `project-not-found` を返す', async () => {
    await explains('`slide convert` の入力の検証のテストです。存在しないディレクトリを指定した場合に、終了コードが 1 で、失敗の理由が `project-not-found` になることを確認します。')
    const itT0 = performance.now()
    const result = runPecotv('convert-missing', [
      'slide', 'convert',
      temporaryRoot('nonexistent'),
      '--out', temporaryRoot('x.pptx'),
      '--json',
    ])
    expect(result.status).toBe(1)
    expect(lastKind(result.stdout)).toBe('project-not-found')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 60_000)

  it('`--theme` に不正な値を指定すると、終了コード 1 で `invalid-theme` を返す', async () => {
    await explains('`slide convert` のテーマの指定の検証のテストです。`--theme` にシェルの構文を含む不正な値を指定した場合に、終了コードが 1 で、失敗の理由が `invalid-theme` になることを確認します。')
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj3-theme')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# slides\n')
    const result = runPecotv('convert-bad-theme', [
      'slide', 'convert', projectDirectory,
      '--out', temporaryRoot('x.pptx'),
      '--theme', '$(rm -rf /)',
      '--json',
    ])
    expect(result.status).toBe(1)
    expect(lastKind(result.stdout)).toBe('invalid-theme')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 60_000)

  it('`slide create` が起動するプロセスの中で、Python 関連のコマンドを起動しない', async () => {
    await explains('Python を使わないことのテストです。`strace` で `slide create` の子プロセスまでたどった場合に、`python`・`python3`・`uvx`・`uv` の起動が 0 件であることを確認します。')
    if (!isStraceAvailable()) {
      console.warn('[CUJ 3] strace 不在のため Python フリー assertion を skip')
      return
    }
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj3-strace')
    const call = toolCommandOf(['slide', 'create', projectDirectory, '--theme', copyFixtureTheme('with-declaration', temporaryRoot('theme-cuj3-strace')).spec])
    const result = await runWithoutPython(
      call.command,
      call.arguments_,
      {
        env: { ...process.env, ...call.environment },
        timeoutMs: 180_000,
      },
    )
    expect(result.exitCode).toBe(0)
    // 一部のシステム呼び出しでは strace 自身が python を起動しないことを念のため確認
    expect(parsePythonExecves(result.stderr)).toEqual([])
    expect(result.pythonExecves).toEqual([])
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 240_000)

  it('`drawio url` が起動するプロセスの中で、Python 関連のコマンドを起動しない', async () => {
    await explains('Python を使わないことのテストです。`strace` で `drawio url` の子プロセスまでたどった場合に、`python`・`python3`・`uvx`・`uv` の起動が 0 件で、`drawio.url.done` を返すことを確認します。')
    if (!isStraceAvailable()) {
      console.warn('[CUJ 3] strace 不在のため drawio url Python フリー assertion を skip')
      return
    }
    const itT0 = performance.now()
    const fixture = path.resolve(
      CLI_TS_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio',
    )
    const call = toolCommandOf(['drawio', 'url', fixture])
    const result = await runWithoutPython(
      call.command,
      call.arguments_,
      {
        env: { ...process.env, ...call.environment },
        timeoutMs: 30_000,
      },
    )
    expect(result.exitCode).toBe(0)
    expect(parsePythonExecves(result.stderr)).toEqual([])
    expect(result.pythonExecves).toEqual([])
    // stdout 末尾行が drawio.url.done をパース可能
    const lastLine = result.stdout.trim().split('\n').findLast(l => l.length > 0) ?? ''
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
    const parsed = JSON.parse(lastLine) as { event: string, url: string }
    expect(parsed.event).toBe('drawio.url.done')
    expect(parsed.url.startsWith('https://app.diagrams.net/')).toBe(true)
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 60_000)
})
