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

describe('hasFlockCommand', () => {
  it('実行環境に flock(1) があるかを true / false で返す', () => {
    // 値そのものはホスト依存 (util-linux 前提のため macOS では false)。
    expect(typeof hasFlockCommand()).toBe('boolean')
  })
})

describe('withFlock', () => {
  it('ロックの置き場所が決まらなければ包まない (ロックなしで実行する)', () => {
    // flock(1) は親ディレクトリが無いとロックファイルを作れず exit 66 で終わるため、
    // 場所が決まらないときにパスを組み立てて渡すと取得そのものが必ず失敗する。
    expect(withFlock(undefined, '/bin/node', ['install'])).toEqual({
      command: '/bin/node',
      commandArguments: ['install'],
    })
  })

  it('flock(1) がある環境では待ち上限と衝突 exit code を付けて包む', () => {
    // flock(1) が無い環境 (macOS 等) では包まずに実行する (bin/pecotv 側と同じフォールバック)。
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
