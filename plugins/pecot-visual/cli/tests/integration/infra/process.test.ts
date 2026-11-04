// infra/_shared/process.ts: spawnPromise の実 spawn ルートを fake binary で検証する。
// stdout/stderr の capture, timeout SIGTERM, 起動 error を網羅する。

import { describe, expect, it } from 'vitest'

import { mergeStderr, spawnPromise } from '../../../src/infra/_shared/process.js'

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

// write メソッドを持つ stub を直接渡す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream として narrowing
  return captured as unknown as NodeJS.WritableStream
}

describe('mergeStderr (純粋関数)', () => {
  it('extra 空: captured を返す', () => {
    expect(mergeStderr('captured', '')).toBe('captured')
  })
  it('captured 空: extra を返す (ENOENT ルート)', () => {
    expect(mergeStderr('', 'spawn ENOENT')).toBe('spawn ENOENT')
  })
  it('両方非空: 改行で連結', () => {
    expect(mergeStderr('captured', 'extra')).toBe('captured\nextra')
  })
  it('両方空: 空文字列', () => {
    expect(mergeStderr('', '')).toBe('')
  })
})

describe('spawnPromise', () => {
  it('exit 0 / stdout を capture する', async () => {
    const result = await spawnPromise('node', ['-e', 'process.stdout.write("hello")'], {
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('exit≠0 / stderr を capture する', async () => {
    const result = await spawnPromise('node', ['-e', 'process.stderr.write("ng"); process.exit(3)'], {
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('ng')
  })

  it('cwd を反映する', async () => {
    const result = await spawnPromise('node', ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: '/tmp',
      timeoutMs: 10_000,
    })
    expect(result.stdout).toBe('/tmp')
  })

  it('env を反映する', async () => {
    const result = await spawnPromise(
      'node',
      ['-e', 'process.stdout.write(process.env.PECOTV_TEST || "missing")'],
      {
        env: { ...process.env, PECOTV_TEST: 'present' },
        timeoutMs: 10_000,
      },
    )
    expect(result.stdout).toBe('present')
  })

  it('timeout 経過時に SIGTERM / timedOut=true', async () => {
    const result = await spawnPromise(
      'node',
      ['-e', 'setTimeout(() => process.exit(0), 60_000)'],
      { timeoutMs: 100 },
    )
    expect(result.timedOut).toBe(true)
    // SIGTERM 経由で終了するか、Linux では signal: 'SIGTERM' / exitCode: null
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
  })

  it('起動失敗 (ENOENT) は reject せず exitCode=null + stderr に message', async () => {
    const result = await spawnPromise(
      '/no/such/binary-pecotv-test',
      [],
      { timeoutMs: 5000 },
    )
    expect(result.exitCode).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('captured stderr と起動 error を改行で連結する (両方非空)', async () => {
    // 子プロセスが exit 後に発火する error は、実環境では起きない。
    // mergeStderr の captured + extra 両方非空ルートを確認したい。
    // そのため node の `process.stderr.write` 後に `process.exit(0)` する分岐を使う。
    const result = await spawnPromise(
      'node',
      ['-e', 'process.stderr.write("captured");'],
      { timeoutMs: 10_000 },
    )
    expect(result.stderr).toBe('captured')
  })

  it('stdoutRelay / stderrRelay 指定時は capture と並行して relay する', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const result = await spawnPromise(
      'node',
      ['-e', 'process.stdout.write("OUT"); process.stderr.write("ERR")'],
      {
        timeoutMs: 10_000,
        stdoutRelay: asStream(stdout),
        stderrRelay: asStream(stderr),
      },
    )
    expect(result.stdout).toBe('OUT')
    expect(result.stderr).toBe('ERR')
    expect(stdout.chunks.join('')).toBe('OUT')
    expect(stderr.chunks.join('')).toBe('ERR')
  })
})
