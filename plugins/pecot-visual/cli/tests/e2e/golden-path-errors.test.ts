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

import { BIN_PECOTV, assertCliBuilt, createPecotvRunner } from '../_helpers/pecotv-e2e-run.js'
import { isStraceAvailable, parsePythonExecves, runWithoutPython } from '../_helpers/no-python.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { copyFixtureTheme } from '../_helpers/theme-fixtures.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')

// 本ファイルは軽い CUJ を 5 件束ねるため、他 8 ファイルのようなファイル全体ではなく、it 単位で ceiling を引く。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、最も重い it は 1.83s。
// マージン倍率 4.4 倍は 8.1s なので、9s へ切り上げる。
// 性能目標ではなく、hang regression を SIGTERM kill (600s) より手前で落とすための上限。
const PER_IT_CEILING_MS = 9000

const temporaryRoot = useTemporaryDirectory('pecotv-e2e-errors-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'golden-path/errors',
  // 本ファイルは exit 1 / exit 2 を期待する CUJ を含むため、tail は spawnSync timeout のときだけ出す。
  isUnexpectedExit: status => status === null,
})

/**
`--json` の最終行から reason を読む。エラーパスの payload はこの 1 行で完結する。
*/
function lastReason(stdout: string): string {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse narrowing
  return (JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { reason?: string }).reason ?? ''
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('CUJ 3: エラーパス + Python フリー', () => {
  it('既存ディレクトリ + --force 無し → exit 2 / dest-exists', () => {
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj3-exist')
    // create だけを見る CUJ なので、依存を持たない写し（file:）で足りる。
    const theme = copyFixtureTheme('with-declaration', temporaryRoot('theme-cuj3-exist')).spec
    expect(runPecotv('create', ['slide', 'create', projectDirectory, '--theme', theme]).status).toBe(0)
    const second = runPecotv('create-again', ['slide', 'create', projectDirectory, '--theme', theme, '--json'])
    expect(second.status).toBe(2)
    expect(lastReason(second.stdout)).toBe('dest-exists')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 240_000)

  it('不存在 project-dir で slide convert → exit 1 / project-not-found', () => {
    const itT0 = performance.now()
    const result = runPecotv('convert-missing', [
      'slide', 'convert',
      temporaryRoot('nonexistent'),
      '--out', temporaryRoot('x.pptx'),
      '--json',
    ])
    expect(result.status).toBe(1)
    expect(lastReason(result.stdout)).toBe('project-not-found')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 60_000)

  it('--theme 不正値 → exit 2 / invalid-theme', () => {
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
    expect(result.status).toBe(2)
    expect(lastReason(result.stdout)).toBe('invalid-theme')
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 60_000)

  it('黄金パス subprocess ツリーで python / python3 / uvx / uv の execve が 0 件', async () => {
    if (!isStraceAvailable()) {
      console.warn('[CUJ 3] strace 不在のため Python フリー assertion を skip')
      return
    }
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('sample-cuj3-strace')
    const result = await runWithoutPython(
      BIN_PECOTV,
      ['slide', 'create', projectDirectory, '--theme', copyFixtureTheme('with-declaration', temporaryRoot('theme-cuj3-strace')).spec],
      {
        env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
        timeoutMs: 180_000,
      },
    )
    expect(result.exitCode).toBe(0)
    // 一部のシステム呼び出しでは strace 自身が python を起動しないことを念のため確認
    expect(parsePythonExecves(result.stderr)).toEqual([])
    expect(result.pythonExecves).toEqual([])
    expect(performance.now() - itT0).toBeLessThan(PER_IT_CEILING_MS)
  }, 240_000)

  it('drawio url の subprocess ツリーで python / python3 / uvx / uv の execve が 0 件', async () => {
    if (!isStraceAvailable()) {
      console.warn('[CUJ 3] strace 不在のため drawio url Python フリー assertion を skip')
      return
    }
    const itT0 = performance.now()
    const fixture = path.resolve(
      CLI_TS_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio',
    )
    const result = await runWithoutPython(
      BIN_PECOTV,
      ['drawio', 'url', fixture, '--json'],
      {
        env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
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
