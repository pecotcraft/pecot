// infra/_shared/flock.ts の unit test。
//
// chromium 取得と実行時依存の取得は、どちらもこの包み方でロックを取る。
// 包み方が誤っていると、次のどちらかになる。
// 「ロックなしで 2 本同時に実行される」か、「ロック待ち超過を取得失敗と誤って報告する」。
// そのため引数の並びとフォールバックの条件をここで固定する。

import { describe, expect, it } from 'vitest'

import {
  hasFlockCommand,
  LOCK_CONFLICT_EXIT_CODE,
  LOCK_WAIT_SECONDS,
  withFlock,
} from '../../../src/infra/_shared/flock.js'
import { explains } from '../../_helpers/explains.js'

describe('hasFlockCommand', () => {
  it('実行環境に flock(1) があるかどうかを、真偽値で返す', async () => {
    // 値そのものはホスト依存 (util-linux 前提のため macOS では false)。
    await explains('実行環境に `flock(1)` があるかを調べる `hasFlockCommand` のテストです。結果の型が真偽値であることを確認します。')
    expect(typeof hasFlockCommand()).toBe('boolean')
  })
})

describe('withFlock', () => {
  it('ロックファイルの場所を決められなければ、flock で包まず、そのままのコマンドで実行する', async () => {
    // flock(1) は親ディレクトリが無いとロックファイルを作れず exit 66 で終わるため、
    // 場所が決まらないときにパスを組み立てて渡すと取得そのものが必ず失敗する。
    await explains('コマンドを `flock` で包む `withFlock` のテストです。ロックファイルの場所に `undefined` を渡した場合に、`flock` を付けず、元のコマンドと引数をそのまま返すことを確認します。')
    expect(withFlock(undefined, '/bin/node', ['install'])).toEqual({
      command: '/bin/node',
      commandArguments: ['install'],
    })
  })

  it('flock(1) がある環境では、待ち時間の上限と衝突時の終了コードを付けて、コマンドを包む', async () => {
    // flock(1) が無い環境 (macOS 等) では包まずに実行する。
    await explains('`withFlock` のテストです。`flock(1)` がある環境では、`-w`・`-E`・`-F` とロックファイルを先頭に付けて包み、ない環境では元のコマンドをそのまま返すことを確認します。')
    const unwrapped = { command: '/bin/node', commandArguments: ['install', 'chromium'] }
    const wrapped = {
      command: 'flock',
      commandArguments: [
        '-w', String(LOCK_WAIT_SECONDS),
        '-E', String(LOCK_CONFLICT_EXIT_CODE),
        // `-F` が無いと flock が fork し、タイムアウトで SIGTERM を送っても取得コマンドが
        // 孤児として生き残り、継承した fd 越しにロックを保持し続ける。
        '-F',
        '/fake/pecotv.lock',
        '/bin/node',
        'install',
        'chromium',
      ],
    }

    expect(withFlock('/fake/pecotv.lock', '/bin/node', ['install', 'chromium']))
      .toEqual(hasFlockCommand() ? wrapped : unwrapped)
  })
})
