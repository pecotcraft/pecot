// infra/_shared/process.ts: spawnPromise の実 spawn ルートを fake binary で検証する。
// stdout/stderr の capture, timeout SIGTERM, 起動 error を網羅する。

import { describe, expect, it } from 'vitest'

import { mergeStderr, spawnPromise } from '../../../src/infra/_shared/process.js'
import { explains } from '../../_helpers/explains.js'

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
  it('追加のメッセージが空の場合は、取得した標準エラーをそのまま返す', async () => {
    await explains('`mergeStderr` のテストです。追加のメッセージが空の場合に、取得した標準エラーがそのまま返ることを確認します。')
    expect(mergeStderr('captured', '')).toBe('captured')
  })
  it('取得した標準エラーが空の場合は、追加のメッセージをそのまま返す', async () => {
    await explains('`mergeStderr` のテストです。取得した標準エラーが空で、追加のメッセージが `spawn ENOENT` の場合に、そのメッセージが返ることを確認します。')
    expect(mergeStderr('', 'spawn ENOENT')).toBe('spawn ENOENT')
  })
  it('両方が空でない場合は、改行でつないで返す', async () => {
    await explains('`mergeStderr` のテストです。取得した標準エラーと追加のメッセージの両方がある場合に、改行でつないだ文字列が返ることを確認します。')
    expect(mergeStderr('captured', 'extra')).toBe('captured\nextra')
  })
  it('両方が空の場合は、空文字列を返す', async () => {
    await explains('`mergeStderr` のテストです。取得した標準エラーと追加のメッセージがどちらも空の場合に、空文字列が返ることを確認します。')
    expect(mergeStderr('', '')).toBe('')
  })
})

describe('spawnPromise', () => {
  it('終了コード 0 で終わるコマンドは、標準出力を取得する', async () => {
    await explains('`spawnPromise` のテストです。`hello` を標準出力へ出力して終了するコマンドを実行した場合に、終了コードが 0 で、標準出力が `hello` で、タイムアウトしていないことを確認します。')
    const result = await spawnPromise('node', ['-e', 'process.stdout.write("hello")'], {
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('終了コードが 0 以外のコマンドは、終了コードと標準エラーを取得する', async () => {
    await explains('`spawnPromise` のテストです。標準エラーへ `ng` を出力して終了コード 3 で終わるコマンドを実行した場合に、終了コード 3 と `ng` を含む標準エラーが返ることを確認します。')
    const result = await spawnPromise('node', ['-e', 'process.stderr.write("ng"); process.exit(3)'], {
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('ng')
  })

  it('作業ディレクトリを指定すると、そのディレクトリでコマンドを実行する', async () => {
    await explains('`spawnPromise` のテストです。作業ディレクトリに `/tmp` を指定した場合に、コマンドが出力した現在のディレクトリが `/tmp` になることを確認します。')
    const result = await spawnPromise('node', ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: '/tmp',
      timeoutMs: 10_000,
    })
    expect(result.stdout).toBe('/tmp')
  })

  it('環境変数を指定すると、コマンドへ渡す', async () => {
    await explains('`spawnPromise` のテストです。環境変数 `PECOTV_TEST` に `present` を指定した場合に、コマンドが出力した値も `present` になることを確認します。')
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

  it('タイムアウトを過ぎると、SIGTERM で終了させ、timedOut を true にする', async () => {
    await explains('`spawnPromise` のタイムアウトのテストです。終了しないコマンドに 100 ミリ秒のタイムアウトを指定した場合に、`timedOut` が `true` になり、終了コードが 0 でないことを確認します。')
    const result = await spawnPromise(
      'node',
      ['-e', 'setTimeout(() => process.exit(0), 60_000)'],
      { timeoutMs: 100 },
    )
    expect(result.timedOut).toBe(true)
    // SIGTERM 経由で終了するか、Linux では signal: 'SIGTERM' / exitCode: null
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
  })

  it('起動に失敗した場合は、拒否せず、終了コードを null にして標準エラーにメッセージを含める', async () => {
    await explains('`spawnPromise` の起動失敗のテストです。存在しない実行ファイルを指定した場合に、エラーにはならず、終了コードが `null` になり、標準エラーにメッセージが含まれることを確認します。')
    const result = await spawnPromise(
      '/no/such/binary-pecotv-test',
      [],
      { timeoutMs: 5000 },
    )
    expect(result.exitCode).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('標準エラーへ出力して終了するコマンドは、出力した内容をそのまま標準エラーとして返す', async () => {
    await explains('`spawnPromise` の標準エラーの取得のテストです。標準エラーへ `captured` を出力するコマンドを実行した場合に、標準エラーが `captured` と一致することを確認します。')
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

  it('stdoutRelay と stderrRelay を指定すると、取得と並行して出力を転送する', async () => {
    await explains('`spawnPromise` の出力の転送のテストです。標準出力へ `OUT`、標準エラーへ `ERR` を出力するコマンドを実行した場合に、結果と転送先のどちらにも同じ内容が含まれることを確認します。')
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
