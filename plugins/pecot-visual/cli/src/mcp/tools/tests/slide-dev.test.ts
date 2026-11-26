// slide_dev ツールと、その実体である dev サーバレジストリの unit test。
//
// 実プロセスは起こさない。
// 子プロセス・空きポート・HTTP プローブはすべて DevServerDependencies 越しに差し替える。
// ready 待ち / ポート再試行 / タイムアウト / キャンセル / 停止の分岐をここで固定する。
// 実 slidev を起こすルートと、「MCP サーバの終了で孤児を残さない」ことは in-process では観測できない。
// それらは tests/e2e/mcp-tools.test.ts が持つ。

// SDK の CallToolResult は mutable メンバを持つ。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリ配下のテスト生成物のみを触る */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import type { CallToolResult } from '@modelcontextprotocol/server'

import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import {
  createDevServerRegistry,
  devServerDefaultDependencies,
  type DevServerChild,
  type DevServerDependencies,
  type DevServerRegistry,
  type DevServerSpawnOptions,
} from '../../dev-server-registry.js'
import type { ToolCallContext } from '../../server.js'
import type { EnsureThemeLinkedResult } from '../../../commands/slidev-project/linked-theme.js'
import { ThemeFetchError } from '../../../domain/slidev-theme/store-layout.js'
import { ThemeResolveError } from '../../../domain/slidev-theme/talk-theme.js'
import { slideDevTool } from '../slide-dev.js'
import { withOutputCheck } from './_output.js'
import type { EnsureThemeLinked } from '../slide-dev.js'
import type { RuntimeDependencies } from '../_shared.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  return structuredOf(result)
}

function sentenceOf(result: { readonly content?: unknown }): string {
  const content: unknown = result.content
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
}

/**
実 spawn の代わりに使う子プロセス。生存・出力・kill の受信をテストから操作する。
*/
interface FakeChild {
  readonly child: DevServerChild
  readonly killedWith: NodeJS.Signals[]
  writeStderr(text: string): void
  exit(): void
  fail(message: string): void
}

function makeFakeChild(pid: number, options: Readonly<{ killThrows?: boolean }> = {}): FakeChild {
  // 実 ChildProcess と同じ on(event, listener) の面を持たせるため EventEmitter を使う。
  // eslint-disable-next-line unicorn/prefer-event-target
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killedWith: NodeJS.Signals[] = []

  const child: DevServerChild = {
    pid,
    stdout,
    stderr,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      killedWith.push(signal)
      if (options.killThrows === true) throw new Error('kill に失敗しました')
      return true
    },
    // EventEmitter の on はどのイベントも同じ形で受けるため、そのまま委譲する。
    on: emitter.on.bind(emitter),
  }

  return {
    child,
    killedWith,
    writeStderr: (text: string) => {
      stderr.write(text)
    },
    exit: () => {
      emitter.emit('exit')
    },
    fail: (message: string) => {
      emitter.emit('error', new Error(message))
    },
  }
}

/**
テスト用の deps。delay は macrotask を 1 回挟み、pipe した出力の到達を待てるようにする。
*/
function makeDependencies(overrides: Partial<DevServerDependencies> = {}): DevServerDependencies {
  return {
    spawn: () => makeFakeChild(1).child,
    isPortFree: () => Promise.resolve(true),
    defaultPorts: [3030, 3031, 3032, 3033, 3034],
    probe: () => Promise.resolve(true),
    delay: async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    },
    readyTimeoutMs: 100,
    pollIntervalMs: 10,
    killEscalationMs: 1,
    ...overrides,
  }
}

const TALK_DIRECTORY = '/talk/deck'

describe('createDevServerRegistry', () => {
  it('起動して URL とポートを返す', async () => {
    await explains('dev サーバのレジストリ `createDevServerRegistry` の起動のテストです。talk-dir を指定して起動した場合に、既定の最初のポート 3030 で子を起動し、URL・ポート・pid を返すことを確認します。')
    const spawned: DevServerSpawnOptions[] = []
    const registry = createDevServerRegistry(makeDependencies({
      spawn: (options: Readonly<DevServerSpawnOptions>) => {
        spawned.push(options)
        return makeFakeChild(4242).child
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toEqual({ ok: true, url: 'http://localhost:3030', port: 3030, pid: 4242, reused: false })
    expect(spawned).toEqual([{ directory: TALK_DIRECTORY, port: 3030 }])
  })

  it('同じ talk-dir の再呼び出しでは起こし直さず既存を返す', async () => {
    await explains('dev サーバのレジストリの再利用のテストです。同じ talk-dir で続けて起動を要求した場合に、子を起動し直さず、既存のサーバを `reused: true` で返すことを確認します。')
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(4242).child
      },
    }))

    const first = await registry.start(TALK_DIRECTORY)
    const second = await registry.start(TALK_DIRECTORY)

    expect(spawnCount).toBe(1)
    expect(second).toMatchObject({ ok: true, reused: true, port: 3030 })
    expect(first).toMatchObject({ reused: false })
  })

  it('表記の違う同じ talk-dir は同じサーバとして扱う', async () => {
    // 引数を組み立てるのはエージェントで末尾スラッシュの有無は揺れる。正規化しないと
    // 同じデッキに dev サーバが二重に立ち、片方の表記では停止もできなくなる。
    await explains('dev サーバのレジストリの talk-dir の表記のテストです。末尾のスラッシュや `.` を含む表記でも、同じサーバとして再利用され、停止も同じサーバに届くことを確認します。')
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(4242).child
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)
    const trailingSlash = await registry.start(`${TALK_DIRECTORY}/`)
    const dotSegment = await registry.start('/talk/./deck')

    expect(spawnCount).toBe(1)
    expect(started).toMatchObject({ reused: false, port: 3030 })
    expect(trailingSlash).toMatchObject({ reused: true, port: 3030 })
    expect(dotSegment).toMatchObject({ reused: true, port: 3030 })
    // 停止も同じキーへ届く。
    expect(registry.stop(`${TALK_DIRECTORY}/`)).toEqual({ stopped: true, port: 3030 })
  })

  it('預かっていた子が終了していたら、起動し直す', async () => {
    await explains('dev サーバのレジストリの子の終了のテストです。預かっていた子のプロセスがすでに終了している場合に、再び子を起動し、`reused: false` で新しい pid を返すことを確認します。')
    const children = [makeFakeChild(1), makeFakeChild(2)]
    let index = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        const fake = children.at(index)
        index += 1
        if (fake === undefined) throw new Error('spawn の呼び出しが想定より多い')
        return fake.child
      },
    }))

    await registry.start(TALK_DIRECTORY)
    children[0]?.exit()
    const restarted = await registry.start(TALK_DIRECTORY)

    expect(restarted).toMatchObject({ ok: true, reused: false, pid: 2 })
  })

  it('ポートの衝突で子がすぐ終了すると、次の候補のポートで起動し直す', async () => {
    // slidev は --port 明示時 strictPort で動くため、塞がっていれば自動採番せず即 exit 1 する。
    await explains('dev サーバのレジストリのポートの衝突のテストです。先に別のプロセスがポートを使っていて子がすぐ終了した場合に、次の候補のポートで起動し直し、終了した子へシグナルを送らないことを確認します。')
    const children = [makeFakeChild(1), makeFakeChild(2)]
    let index = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        const fake = children.at(index)
        index += 1
        if (fake === undefined) throw new Error('spawn の呼び出しが想定より多い')
        return fake.child
      },
      probe: () => {
        if (index === 1) {
          children[0]?.writeStderr('Error: Port 3030 is already in use\n')
          children[0]?.exit()
          return Promise.resolve(false)
        }
        return Promise.resolve(true)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: true, port: 3031, pid: 2 })
    // 1 本目の後始末。strictPort で自滅済みなのでシグナルは撃たず (生きている子を畳むルートは
    // タイムアウトのテストが見る)、レジストリにも残さない — 残すと stop が 3030 を止めに行く。
    expect(children[0]?.killedWith).toEqual([])
    expect(registry.stop(TALK_DIRECTORY)).toEqual({ stopped: true, port: 3031 })
    expect(children[1]?.killedWith).toEqual(['SIGTERM'])
  })

  it('ready を待つ既定の時間は 15 秒', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-10')
    await explains('dev サーバのレジストリの既定値のテストです。ready を待つ既定の時間が 15 秒であることを確認します。')
    expect(devServerDefaultDependencies().readyTimeoutMs).toBe(15_000)
  })

  it('既定のポートは 3030 から 3034 まで', async () => {
    await explains('dev サーバのレジストリの既定値のテストです。既定のポートの候補が 3030 から 3034 までの 5 つであることを確認します。')
    expect(devServerDefaultDependencies().defaultPorts).toEqual([3030, 3031, 3032, 3033, 3034])
  })

  it('ポートの指定が無ければ既定のポートを小さい順に試し、最初の空きで起動する', async () => {
    await explains('dev サーバのレジストリのポートの選び方のテストです。ポートを指定しない場合に、既定の候補を小さい順に試し、最初の空きのポートで起動することを確認します。')
    const spawned: DevServerSpawnOptions[] = []
    const registry = createDevServerRegistry(makeDependencies({
      spawn: (options: Readonly<DevServerSpawnOptions>) => {
        spawned.push(options)
        return makeFakeChild(21).child
      },
      isPortFree: port => Promise.resolve(port !== 3030),
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: true, port: 3031, url: 'http://localhost:3031' })
    // 使用中と分かっているポートでは子を起こさない。
    expect(spawned).toEqual([{ directory: TALK_DIRECTORY, port: 3031 }])
  })

  it('既定のポートがすべて使用中なら spawn せず失敗を返す', async () => {
    await explains('dev サーバのレジストリのポートがすべて使用中の場合のテストです。既定の候補がすべて使用中のときに、子を起動せず、`dev-server-port-in-use` の失敗を返し、`detail` に候補のポートを含めることを確認します。')
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(22).child
      },
      isPortFree: () => Promise.resolve(false),
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(spawnCount).toBe(0)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-port-in-use', stdout: '', stderr: '' })
    expect(started.ok ? '' : started.detail).toContain('3030 / 3031 / 3032 / 3033 / 3034')
  })

  it('既定のポートがすべて使用中のときの detail は、利用者に確認してから呼び直すよう案内する', async () => {
    await explains('dev サーバのレジストリのポートがすべて使用中の場合の案内のテストです。`detail` に、プレビューを止めてよいか利用者へ確認してから呼び直す案内が含まれることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: () => Promise.resolve(false) }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started.ok ? '' : started.detail).toContain('ask the user whether any preview may be stopped')
  })

  it('指定されたポートで起動する', async () => {
    await explains('dev サーバのレジストリのポートの指定のテストです。ポートを指定した場合に、そのポートで子を起動し、`reused: false` の結果を返すことを確認します。')
    const spawned: DevServerSpawnOptions[] = []
    const registry = createDevServerRegistry(makeDependencies({
      spawn: (options: Readonly<DevServerSpawnOptions>) => {
        spawned.push(options)
        return makeFakeChild(23).child
      },
    }))

    const started = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(started).toMatchObject({ ok: true, port: 5000, url: 'http://localhost:5000', reused: false })
    expect(spawned).toEqual([{ directory: TALK_DIRECTORY, port: 5000 }])
  })

  it('指定されたポートが使用中なら別のポートへ移らず失敗を返す', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-06')
    await explains('dev サーバのレジストリの指定したポートが使用中の場合のテストです。使用中のポートを指定したときに、別のポートへ移らず、子を起動せずに `dev-server-port-in-use` の失敗を返すことを確認します。')
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(24).child
      },
      isPortFree: port => Promise.resolve(port !== 5000),
    }))

    const started = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(spawnCount).toBe(0)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-port-in-use' })
    expect(started.ok ? '' : started.detail).toContain('5000')
  })

  it('指定された port が使用中のときの detail は、利用者に確認してから呼び直すよう案内する', async () => {
    await explains('dev サーバのレジストリの指定したポートが使用中の場合の案内のテストです。`detail` に、どのポートを使うか利用者へ確認する案内が含まれることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: port => Promise.resolve(port !== 5000) }))

    const started = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(started.ok ? '' : started.detail).toContain('ask which port to use')
  })

  it('指定されたポートを起動直前に奪われたら、捕捉した出力を添えて失敗を返す', async () => {
    await explains('dev サーバのレジストリの指定したポートを奪われた場合のテストです。起動の直前に別のプロセスがポートを使った場合は、`dev-server-port-in-use` の失敗を返し、捕捉した標準エラー出力を含めることを確認します。')
    let spawnCount = 0
    let current: FakeChild | undefined
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        current = makeFakeChild(25)
        return current.child
      },
      probe: () => {
        current?.writeStderr('Error: Port 5000 is already in use\n')
        current?.exit()
        return Promise.resolve(false)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(spawnCount).toBe(1)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-port-in-use' })
    expect(started.ok ? '' : started.stderr).toContain('Port 5000 is already in use')
  })

  it('起動済みの talk-dir へ同じポートを指定したら既存を返す', async () => {
    await explains('dev サーバのレジストリの起動済みの talk-dir のテストです。起動済みの talk-dir に同じポートを指定した場合に、子を起動し直さず、既存のサーバを `reused: true` で返すことを確認します。')
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(26).child
      },
    }))
    await registry.start(TALK_DIRECTORY)

    const again = await registry.start(TALK_DIRECTORY, { port: 3030 })

    expect(spawnCount).toBe(1)
    expect(again).toMatchObject({ ok: true, reused: true, port: 3030 })
  })

  it('起動済みの talk-dir へ別のポートを指定したら、既存を止めて指定のポートで開き直す', async () => {
    await explains('dev サーバのレジストリの起動済みの talk-dir のテストです。別のポートを指定した場合に、既存のサーバを `SIGTERM` で止め、指定したポートで起動し直すことを確認します。')
    const children = [makeFakeChild(27), makeFakeChild(28)]
    let index = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        const fake = children.at(index)
        index += 1
        if (fake === undefined) throw new Error('spawn の呼び出しが想定より多い')
        return fake.child
      },
    }))
    await registry.start(TALK_DIRECTORY)

    const reopened = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(reopened).toMatchObject({ ok: true, reused: false, port: 5000, pid: 28 })
    expect(children[0]?.killedWith).toEqual(['SIGTERM'])
    // 預かっているのは開き直した側だけ。
    expect(registry.stop(TALK_DIRECTORY)).toEqual({ stopped: true, port: 5000 })
  })

  it('開き直しの指定先が使用中なら、既存を止めずに失敗を返す', async () => {
    // 止めてから起動に失敗すると、動いていたプレビューまで失う。
    await explains('dev サーバのレジストリのポートの変更に失敗する場合のテストです。変更先のポートが使用中のときに、既存のサーバを止めず、`dev-server-port-in-use` の失敗を返して、既存のサーバを使い続けられることを確認します。')
    const fake = makeFakeChild(29)
    let spawnCount = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return fake.child
      },
      isPortFree: port => Promise.resolve(port !== 5000),
    }))
    await registry.start(TALK_DIRECTORY)

    const reopened = await registry.start(TALK_DIRECTORY, { port: 5000 })
    const current = await registry.start(TALK_DIRECTORY)

    expect(reopened).toMatchObject({ ok: false, reason: 'dev-server-port-in-use' })
    expect(fake.killedWith).toEqual([])
    expect(spawnCount).toBe(1)
    expect(current).toMatchObject({ ok: true, reused: true, port: 3030 })
  })

  it('起動済みの talk-dir へ別のポートを指定した呼び出しが中断済みなら、既存を止めずに cancelled を返す', async () => {
    await explains('dev サーバのレジストリのキャンセルのテストです。別のポートを指定した呼び出しがすでに中断されている場合に、既存のサーバを止めず、`dev-server-cancelled` の失敗を返すことを確認します。')
    const fake = makeFakeChild(30)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    const controller = new AbortController()
    controller.abort()
    const reopened = await registry.start(TALK_DIRECTORY, { port: 5000, signal: controller.signal })

    expect(reopened).toMatchObject({ ok: false, reason: 'dev-server-cancelled' })
    expect(fake.killedWith).toEqual([])
    // 既存はそのまま動き続けている。
    expect(registry.stop(TALK_DIRECTORY)).toEqual({ stopped: true, port: 3030 })
  })

  it('ポート衝突以外で即死したときは再試行しない', async () => {
    await explains('dev サーバのレジストリの子がすぐ終了した場合のテストです。ポートの衝突以外の原因で子が終了したときに、起動を再試行せず、`dev-server-exited` の失敗と標準エラー出力を返すことを確認します。')
    let spawnCount = 0
    let current: FakeChild | undefined
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        current = makeFakeChild(spawnCount)
        return current.child
      },
      probe: () => {
        current?.writeStderr('SyntaxError: slides.md が破損しています\n')
        current?.exit()
        return Promise.resolve(false)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(spawnCount).toBe(1)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-exited' })
    expect(started.ok ? '' : started.stderr).toContain('slides.md が破損しています')
  })

  it('ready にならないまま待ち時間が過ぎると、dev-server-timeout を返して子を止める', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-10')
    await explains('dev サーバのレジストリの起動の待ち時間のテストです。待ち時間が過ぎても ready にならない場合は、`dev-server-timeout` の失敗を返し、子へ `SIGTERM` を送ることを確認します。')
    const fake = makeFakeChild(7)
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => fake.child,
      probe: () => Promise.resolve(false),
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: false, reason: 'dev-server-timeout' })
    expect(started.ok ? '' : started.detail).toContain('100ms')
    expect(fake.killedWith).toContain('SIGTERM')
  })

  it('200 を返したのが自分の子でなければ ready と見なさない', async () => {
    // ポートを掴んでいた別プロセスの応答を掴んで、他人のサーバの URL を返さないための組。
    await explains('dev サーバのレジストリの ready の判定のテストです。応答が成功でも、返したのが自分の子のプロセスでない場合に、ready とみなさず、`dev-server-exited` の失敗を返すことを確認します。')
    const fake = makeFakeChild(8)
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => fake.child,
      probe: () => {
        fake.exit()
        return Promise.resolve(true)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: false, reason: 'dev-server-exited' })
  })

  it('spawn そのものが失敗したら理由付きで返す', async () => {
    await explains('dev サーバのレジストリの子の起動に失敗した場合のテストです。子の起動で例外が発生したときに、`dev-server-spawn-failed` の失敗を返し、`detail` に例外の内容を含めることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        throw new Error('@slidev/cli が解決できません')
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: false, reason: 'dev-server-spawn-failed', stdout: '', stderr: '' })
    expect(started.ok ? '' : started.detail).toContain('@slidev/cli が解決できません')
  })

  it('子の error イベントを拾って stderr に載せる (未処理だと MCP サーバごと落ちる)', async () => {
    await explains('dev サーバのレジストリの子の `error` イベントのテストです。子が `error` イベントを発行した場合に、MCP サーバを停止させず、標準エラー出力に内容を載せた `dev-server-exited` の失敗を返すことを確認します。')
    const fake = makeFakeChild(9)
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => fake.child,
      probe: () => {
        fake.fail('spawn ENOENT')
        return Promise.resolve(false)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started).toMatchObject({ ok: false, reason: 'dev-server-exited' })
    expect(started.ok ? '' : started.stderr).toContain('spawn ENOENT')
  })

  it('呼び出しがキャンセルされたら起動途中の子を止める', async () => {
    await explains('dev サーバのレジストリのキャンセルのテストです。起動の途中で呼び出しがキャンセルされた場合に、`dev-server-cancelled` の失敗を返し、子へ `SIGTERM` を送ることを確認します。')
    const fake = makeFakeChild(10)
    const controller = new AbortController()
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => fake.child,
      probe: () => {
        controller.abort()
        return Promise.resolve(false)
      },
    }))

    const started = await registry.start(TALK_DIRECTORY, { signal: controller.signal })

    expect(started).toMatchObject({ ok: false, reason: 'dev-server-cancelled' })
    expect(fake.killedWith).toContain('SIGTERM')
  })

  it('abort 済みの signal では spawn せずに打ち切る', async () => {
    await explains('dev サーバのレジストリのキャンセルのテストです。すでに中断された `signal` を渡した場合に、子を起動せず、`dev-server-cancelled` の失敗を返すことを確認します。')
    let spawnCount = 0
    const controller = new AbortController()
    controller.abort()
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(11).child
      },
    }))

    const started = await registry.start(TALK_DIRECTORY, { signal: controller.signal })

    expect(spawnCount).toBe(0)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-cancelled' })
  })

  it('既定のポートがすべて使用中かつ abort 済みの signal では、spawn せず cancelled を返す', async () => {
    // 全候補が isPortFree で continue するだけだと、attemptStart (中断を見る場所) に一度も到達しない。
    // そのため候補ループの先頭でも中断を見ないと、port-in-use を誤って返してしまう。
    await explains('dev サーバのレジストリのキャンセルのテストです。既定のポートがすべて使用中でも、中断された `signal` を渡した場合は、子を起動せず `dev-server-cancelled` を返すことを確認します。')
    let spawnCount = 0
    const controller = new AbortController()
    controller.abort()
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        spawnCount += 1
        return makeFakeChild(31).child
      },
      isPortFree: () => Promise.resolve(false),
    }))

    const started = await registry.start(TALK_DIRECTORY, { signal: controller.signal })

    expect(spawnCount).toBe(0)
    expect(started).toMatchObject({ ok: false, reason: 'dev-server-cancelled' })
  })

  it('stop は預かっているサーバを止め、動いていなければ止めなかったと返す', async () => {
    await explains('dev サーバのレジストリの停止のテストです。`stop` を呼んだ場合に、預かっているサーバを止めてポートを返し、2 回目は動いていないので `stopped: false` を返すことを確認します。')
    const fake = makeFakeChild(12)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    const stopped = registry.stop(TALK_DIRECTORY)
    const again = registry.stop(TALK_DIRECTORY)

    expect(stopped).toEqual({ stopped: true, port: 3030 })
    expect(fake.killedWith).toEqual(['SIGTERM'])
    expect(again).toEqual({ stopped: false, port: undefined })
  })

  it('自力で落ちたサーバへの stop はポートを載せずに止めなかったと返す', async () => {
    // 「起動中のサーバはありません」という応答にポート番号が付くと読み取れない。
    await explains('dev サーバのレジストリの停止のテストです。自力で終了したサーバに `stop` を呼んだ場合に、ポートを含めず `stopped: false` を返し、終了した子へシグナルを送らないことを確認します。')
    const fake = makeFakeChild(17)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)
    fake.exit()

    const stopped = registry.stop(TALK_DIRECTORY)

    expect(stopped).toEqual({ stopped: false, port: undefined })
    expect(fake.killedWith, '死んだ子へシグナルは撃たない').toEqual([])
  })

  it('SIGTERM で終了しない子には、続けて SIGKILL を送る', async () => {
    await explains('dev サーバのレジストリの停止のテストです。`SIGTERM` で終了しない子に対して、一定の時間の後に `SIGKILL` を送ることを確認します。')
    const fake = makeFakeChild(13)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    registry.stop(TALK_DIRECTORY)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })

    expect(fake.killedWith).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('kill が失敗しても、停止の要求は例外を発生させずに結果を返す', async () => {
    await explains('dev サーバのレジストリの停止のテストです。子の `kill` が例外を発生させた場合でも、`stop` が例外を伝えず、`stopped: true` とポートを返すことを確認します。')
    const fake = makeFakeChild(14, { killThrows: true })
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    expect(registry.stop(TALK_DIRECTORY)).toEqual({ stopped: true, port: 3030 })
  })

  it('shutdown は預かっている全てのサーバを止める', async () => {
    await explains('dev サーバのレジストリの `shutdown` のテストです。複数の talk-dir のサーバを預かっている場合に、すべての子へ `SIGTERM` を送り、以降の `stop` が `stopped: false` を返すことを確認します。')
    const children = [makeFakeChild(15), makeFakeChild(16)]
    let index = 0
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        const fake = children.at(index)
        index += 1
        if (fake === undefined) throw new Error('spawn の呼び出しが想定より多い')
        return fake.child
      },
    }))
    await registry.start('/talk/a')
    await registry.start('/talk/b')

    registry.shutdown()

    expect(children.map(fake => fake.killedWith)).toEqual([['SIGTERM'], ['SIGTERM']])
    expect(registry.stop('/talk/a')).toEqual({ stopped: false, port: undefined })
  })
})

/**
起動を要求されたら必ず失敗する registry。ガードで止まる前提のテストに渡す。
*/
function unusedRegistry(): DevServerRegistry {
  return {
    start: () => {
      throw new Error('ガードで止まるのでレジストリには触れない')
    },
    stop: () => {
      throw new Error('ガードで止まるのでレジストリには触れない')
    },
    stopAndWait: () => {
      throw new Error('ガードで止まるのでレジストリには触れない')
    },
    shutdown: () => {
      throw new Error('ガードで止まるのでレジストリには触れない')
    },
  }
}

function runtimeDependencies(isInstalled: boolean): RuntimeDependencies {
  return {
    isInstalled: () => isInstalled,
    root: () => '/fake/pecotv-runtime',
    install: () => {
      throw new Error('ツールは実行時依存を取得しない (取得は runtime_setup ツールの責務)')
    },
  }
}

function installedRuntimeDependencies(): RuntimeDependencies {
  return runtimeDependencies(true)
}

/**
既定 deps を組み立てずにハンドラを呼べるツール (レジストリと実行時依存を注入する)。
*/
function toolWith(
  registry: DevServerRegistry,
  ensureThemeLinked: EnsureThemeLinked = () => Promise.resolve(NOT_RELINKED),
): ReturnType<typeof slideDevTool> {
  return withOutputCheck(slideDevTool(() => registry, installedRuntimeDependencies, () => ensureThemeLinked))
}

const NOT_RELINKED: EnsureThemeLinkedResult = {
  relinked: false, regenerated: false,
  theme: { name: 'slidev-theme-sample', spec: 'git+https://example.com/org/theme.git#v1.0.0', directory: '/store/theme/package' },
  nodeModulesTarget: undefined,
}

// 取得中に警告を出してから、接続の失敗で終わる ensureThemeLinked。
const failingAfterWarning: EnsureThemeLinked = (_directory, context) => {
  context.warn?.('取得中の警告')
  return Promise.reject(new ThemeFetchError('接続できません', 'connection'))
}

describe('createDevServerRegistry.stopAndWait', () => {
  it('止めたサーバのプロセスが終わるまで待ってから戻る', async () => {
    await explains('dev サーバのレジストリの `stopAndWait` のテストです。サーバを止めた場合に、子のプロセスが終了するまで待ってから、`stopped: true` とポートを返すことを確認します。')
    const fake = makeFakeChild(10)
    const delays: number[] = []
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => fake.child,
      delay: (ms) => {
        delays.push(ms)
        // 2 回待ったところで子が終わる。
        if (delays.length === 2) fake.exit()
        return Promise.resolve()
      },
    }))
    await registry.start(TALK_DIRECTORY)
    const before = delays.length

    const result = await registry.stopAndWait(TALK_DIRECTORY)

    expect(result).toEqual({ stopped: true, port: 3030 })
    expect(fake.killedWith).toEqual(['SIGTERM'])
    expect(delays.length - before).toBeGreaterThanOrEqual(1)
  })

  it('動いていなければ待たずに stopped: false で戻る', async () => {
    await explains('dev サーバのレジストリの `stopAndWait` のテストです。動いているサーバがない場合に、待たずに `stopped: false` を返すことを確認します。')
    const registry = createDevServerRegistry(makeDependencies())

    expect(await registry.stopAndWait(TALK_DIRECTORY)).toEqual({ stopped: false, port: undefined })
  })

  it('SIGTERM を無視して生き続ける子でも、待ちを打ち切って戻る', async () => {
    await explains('dev サーバのレジストリの `stopAndWait` のテストです。子が `SIGTERM` を無視して生き続ける場合でも、待ちを打ち切り、`stopped: true` とポートを返すことを確認します。')
    const fake = makeFakeChild(11)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child, delay: () => Promise.resolve() }))
    await registry.start(TALK_DIRECTORY)

    expect(await registry.stopAndWait(TALK_DIRECTORY)).toEqual({ stopped: true, port: 3030 })
  })
})

describe('slideDevTool', () => {
  let workDirectory = ''
  let talkDirectory = ''

  beforeEach(() => {
    workDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-slide-dev-'))
    talkDirectory = path.join(workDirectory, 'deck')
    mkdirSync(path.join(talkDirectory, 'node_modules'), { recursive: true })
    writeFileSync(path.join(talkDirectory, 'slides.md'), '# deck\n', 'utf8')
  })

  afterEach(() => {
    rmSync(workDirectory, { recursive: true, force: true })
  })

  it('dir が相対パスなら、実処理の前に invalid-path のエラーを返す', async () => {
    await explains('`slide_dev` ツールの入力パスの検証のテストです。`dir` に相対パスを指定した場合に、`invalid-path` のエラーと `invalidPaths` を返すことを確認します。')
    const result = await toolWith(unusedRegistry()).handler({ dir: 'relative/deck', stop: false }, CALL)

    expect(structuredOf(result)['kind']).toBe('invalid-path')
    expect(dataOf(result)).toHaveProperty('invalidPaths')
  })

  it('talk-dir が存在しないと、子を起動せずに talk-dir-not-found のエラーを返し、log を載せない', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-07')
    await explains('`slide_dev` ツールの入力ディレクトリの検証のテストです。存在しないディレクトリを指定した場合に、子を起動せず `talk-dir-not-found` のエラーを返し、`log` を含めないことを確認します。')
    const result = await toolWith(unusedRegistry()).handler(
      { dir: path.join(workDirectory, 'no-such-deck'), stop: false },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('talk-dir-not-found')
    expect(dataOf(result)).not.toHaveProperty('log')
    expect(structuredOf(result)).not.toHaveProperty('stderr')
  })

  it('slides.md がないと、slides-md-not-found のエラーを返す', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-07')
    await explains('`slide_dev` ツールの入力ディレクトリの検証のテストです。`slides.md` を持たないディレクトリを指定した場合に、Slidev のプロジェクトとして扱わず、`slides-md-not-found` のエラーを返すことを確認します。')
    rmSync(path.join(talkDirectory, 'slides.md'))

    const result = await toolWith(unusedRegistry()).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(structuredOf(result)['kind']).toBe('slides-md-not-found')
  })

  it('node_modules を解決できなければ slide_sync を案内する', async () => {
    // 実環境では talk-dir/node_modules は依存ルートへの symlink で、切れると vite が
    // 不明瞭な失敗をする。start.mjs と同じ案内を spawn 前に返す。
    await explains('`slide_dev` ツールの `node_modules` の検証のテストです。`node_modules` を解決できない場合に、`node-modules-unresolved` のエラーを返し、`slide_sync` を案内する `detail` を含めることを確認します。')
    rmSync(path.join(talkDirectory, 'node_modules'), { recursive: true })

    const result = await toolWith(unusedRegistry()).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(structuredOf(result)['kind']).toBe('node-modules-unresolved')
    expect(String(dataOf(result)['detail'])).toContain('`slide_sync`')
  })

  it('既定の張り直しは、テーマを参照しない talk-dir (slides.md に theme が無い) を theme-none で止める', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-08')
    // 3 つ目の引数を省き、既定の ensureTalkThemeLinked (実ファイルを読む) を通す。
    await explains('`slide_dev` ツールの既定のテーマの張り直しのテストです。`slides.md` に `theme` がない talk-dir を渡した場合に、`theme-none` のエラーを返して止まることを確認します。')
    const tool = withOutputCheck(slideDevTool(() => unusedRegistry(), installedRuntimeDependencies))

    const result = await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('theme-none')
  })

  it('テーマの取得に失敗したら、原因ごとの reason と文言で止まり、spawn しない', async () => {
    await explains('`slide_dev` ツールのテーマの取得に失敗した場合のテストです。原因ごとの `kind` と文言のエラーを返し、子を起動しないことを確認します。')
    const failure = new ThemeFetchError('テーマの取得元 https://example.com/x.git にタグ \'v9.9.9\' がありません。タグ名を確認してください。', 'tag')

    const result = await toolWith(unusedRegistry(), () => Promise.reject(failure)).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(dataOf(result)['event']).toBe('slide.dev.error')
    expect(structuredOf(result)['kind']).toBe('theme-tag')
    expect(String(dataOf(result)['detail'])).toContain('タグ名を確認してください')
  })

  it('テーマを参照しない talk-dir (移行前の形) は theme-none で止まる', async () => {
    await explains('`slide_dev` ツールのテーマの解決に失敗した場合のテストです。テーマを参照しない移行前の talk-dir の場合に、`theme-none` のエラーを返すことを確認します。')
    const failure = new ThemeResolveError('テーマを参照していません。slide_sync の theme を渡してください', 'theme-none')

    const result = await toolWith(unusedRegistry(), () => Promise.reject(failure)).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(structuredOf(result)['kind']).toBe('theme-none')
  })

  it('テーマの張り直しは node_modules の確認より前に行う (張り直しで復旧できる状態を拒まない)', async () => {
    await explains('`slide_dev` ツールの処理の順序のテストです。`node_modules` がなくても、テーマの張り直しで復旧できるため、張り直しを先に行い、起動に成功することを確認します。')
    rmSync(path.join(talkDirectory, 'node_modules'), { recursive: true })
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(556).child }))
    const ensureThemeLinked: EnsureThemeLinked = () => {
      mkdirSync(path.join(talkDirectory, 'node_modules'), { recursive: true })
      return Promise.resolve({ ...NOT_RELINKED, relinked: true, regenerated: false, nodeModulesTarget: '/runtime/current/node_modules' })
    }

    const result = await toolWith(registry, ensureThemeLinked).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)['event']).toBe('slide.dev.started')
  })

  it('張り直したときは、起動済みのサーバを止めてから起動し直す', async () => {
    await explains('`slide_dev` ツールのテーマを張り直した場合のテストです。テーマを張り直したときに、起動済みのサーバを `stopAndWait` で止めてから、`start` で起動し直すことを確認します。')
    const calls: string[] = []
    const registry: DevServerRegistry = {
      start: () => {
        calls.push('start')
        return Promise.resolve({ ok: true, url: 'http://localhost:3030', port: 3030, pid: 1, reused: false })
      },
      stop: () => {
        calls.push('stop')
        return { stopped: true, port: 3030 }
      },
      stopAndWait: () => {
        calls.push('stopAndWait')
        return Promise.resolve({ stopped: true, port: 3030 })
      },
      shutdown: () => { calls.push('shutdown') },
    }

    await toolWith(registry, () => Promise.resolve({ ...NOT_RELINKED, relinked: true })).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(calls).toStrictEqual(['stopAndWait', 'start'])
  })

  it('生成ファイルを書き直したときも、起動済みのサーバを止めてから起動し直す', async () => {
    await explains('`slide_dev` ツールの生成ファイルの書き直しのテストです。生成ファイルを書き直したときも、起動済みのサーバを `stopAndWait` で止めてから、`start` で起動し直すことを確認します。')
    const calls: string[] = []
    const registry: DevServerRegistry = {
      start: () => {
        calls.push('start')
        return Promise.resolve({ ok: true, url: 'http://localhost:3030', port: 3030, pid: 1, reused: false })
      },
      stop: () => {
        calls.push('stop')
        return { stopped: true, port: 3030 }
      },
      stopAndWait: () => {
        calls.push('stopAndWait')
        return Promise.resolve({ stopped: true, port: 3030 })
      },
      shutdown: () => { calls.push('shutdown') },
    }

    await toolWith(registry, () => Promise.resolve({ ...NOT_RELINKED, regenerated: true })).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(calls).toStrictEqual(['stopAndWait', 'start'])
  })

  it('張り直しと書き直しが無ければ、起動済みのサーバを止めない', async () => {
    await explains('`slide_dev` ツールの張り直しがない場合のテストです。テーマの張り直しも生成ファイルの書き直しもない場合に、起動済みのサーバを止めず、`start` だけを呼ぶことを確認します。')
    const calls: string[] = []
    const registry: DevServerRegistry = {
      start: () => {
        calls.push('start')
        return Promise.resolve({ ok: true, url: 'http://localhost:3030', port: 3030, pid: 1, reused: true })
      },
      stop: () => {
        calls.push('stop')
        return { stopped: true, port: 3030 }
      },
      stopAndWait: () => {
        calls.push('stopAndWait')
        return Promise.resolve({ stopped: true, port: 3030 })
      },
      shutdown: () => { calls.push('shutdown') },
    }

    await toolWith(registry, () => Promise.resolve(NOT_RELINKED)).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(calls).toStrictEqual(['start'])
  })

  it('MCP のキャンセルの signal と警告の出力先を、テーマの取得へ渡し、警告を warnings に載せる', async () => {
    await explains('`slide_dev` ツールのテーマの取得への引数のテストです。MCP のキャンセルの `signal` と警告の出力先を、テーマの取得へ渡し、取得中の警告が結果の `warnings` に含まれることを確認します。')
    const received: { signal: AbortSignal | undefined }[] = []
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(557).child }))
    const controller = new AbortController()
    const ensureThemeLinked: EnsureThemeLinked = (_directory, context) => {
      received.push({ signal: context.signal })
      context.warn?.('取得中の警告')
      return Promise.resolve(NOT_RELINKED)
    }

    const result = await toolWith(registry, ensureThemeLinked).handler(
      { dir: talkDirectory, stop: false },
      { signal: controller.signal },
    )

    expect(received).toEqual([{ signal: controller.signal }])
    expect(dataOf(result)['warnings']).toEqual(['取得中の警告'])
  })

  it('テーマの取得に失敗したときも、取得中の警告を warnings に残す', async () => {
    await explains('`slide_dev` ツールのテーマの取得に失敗した場合の警告のテストです。接続の失敗で終わる場合でも、取得中に出た警告が `warnings` に含まれることを確認します。')
    const result = await toolWith(unusedRegistry(), failingAfterWarning).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(structuredOf(result)['kind']).toBe('theme-connection')
    expect(dataOf(result)['warnings']).toEqual(['取得中の警告'])
  })

  it('張り直しが無ければ、起動済みのサーバを止めずに再利用へ進む', async () => {
    await explains('`slide_dev` ツールの張り直しがない場合の再利用のテストです。テーマの張り直しがない場合に、起動済みのサーバを止めず、既存のサーバの再利用へ進むことを確認します。')
    const calls: string[] = []
    const registry: DevServerRegistry = {
      start: () => {
        calls.push('start')
        return Promise.resolve({ ok: true, url: 'http://localhost:3030', port: 3030, pid: 1, reused: true })
      },
      stop: () => {
        calls.push('stop')
        return { stopped: true, port: 3030 }
      },
      stopAndWait: () => {
        calls.push('stopAndWait')
        return Promise.resolve({ stopped: true, port: 3030 })
      },
      shutdown: () => { calls.push('shutdown') },
    }

    await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(calls).toStrictEqual(['start'])
  })

  it('起動できたら URL・ポート・pid を data に載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-01')
    await explains('`slide_dev` ツールの起動の成功のテストです。起動が成功した場合は、`slide.dev.started` と URL・ポート・pid を結果に含め、本文にも URL が含まれることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(555).child }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toEqual({
      event: 'slide.dev.started',
      dir: talkDirectory,
      url: 'http://localhost:3030',
      port: 3030,
      reused: false,
      pid: 555,
    })
    expect(sentenceOf(result)).toContain('http://localhost:3030')
  })

  it('port を指定したらそのポートで起動する', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-03')
    await explains('`slide_dev` ツールのポートの指定のテストです。`port` を指定した場合に、そのポートで起動し、結果の URL にもそのポートが含まれることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(560).child }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, port: 5000, stop: false }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.started', port: 5000, url: 'http://localhost:5000' })
  })

  it('指定した port が使用中なら理由付きで失敗を返す', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-06')
    await explains('`slide_dev` ツールの指定したポートが使用中の場合のテストです。使用中のポートを `port` で指定した場合に、`dev-server-port-in-use` のエラーを返し、本文にポート番号が含まれることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: () => Promise.resolve(false) }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, port: 5000, stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('dev-server-port-in-use')
    expect(sentenceOf(result)).toContain('5000')
  })

  it.each([0, 65_536, 3030.5])('ポートとして成り立たない port (%s) は受け付けない', async (port) => {
    // 投げられるのが schema.parse (parsePathArguments) の ZodError であること、拒否した先が
    // port であることまで見る。rejects.toThrow() だけでは、別の理由で reject しても通ってしまう。
    await explains('`slide_dev` ツールのポートの検証のテストです。`0`・`65536`・`3030.5` のようにポートとして成り立たない値を指定した場合に、`port` を指す `ZodError` が発生することを確認します。')
    let rejection: unknown
    try {
      await toolWith(unusedRegistry()).handler({ dir: talkDirectory, port, stop: false }, CALL)
    }
    catch (error: unknown) {
      rejection = error
    }

    if (!(rejection instanceof ZodError)) throw new Error('ZodError が投げられていません')
    expect(rejection.issues.some(issue => issue.path.includes('port'))).toBe(true)
  })

  it('起動済みなら reused として同じ URL を返す', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-02')
    await explains('`slide_dev` ツールの再利用のテストです。起動済みの talk-dir を再び指定した場合は、`slide.dev.reused` と同じポートを返し、`reused` が `true` になることを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(556).child }))
    const tool = toolWith(registry)
    await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    const result = await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.reused', reused: true, port: 3030 })
  })

  it('起動に失敗したら、捕捉した出力を log に添えて返す', async () => {
    await explains('`slide_dev` ツールの起動に失敗した場合のテストです。子がエラーを出力して終了した場合に、`dev-server-exited` のエラーを返し、捕捉した出力を `log` に含めることを確認します。')
    let current: FakeChild | undefined
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        current = makeFakeChild(557)
        return current.child
      },
      probe: () => {
        current?.writeStderr('Error: 起動に失敗\n')
        current?.exit()
        return Promise.resolve(false)
      },
    }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('dev-server-exited')
    expect(String(dataOf(result)['log'])).toContain('起動に失敗')
    expect(String(dataOf(result)['detail'])).toContain('see log')
  })

  it('起動に失敗した子の出力が上限を超えても、早く出た warning を warnings に残す', async () => {
    await explains('`slide_dev` ツールの起動に失敗した場合の警告のテストです。子の出力が上限を超えても、先に出た警告が `warnings` に残り、上限を超えた出力側の `log` には含まれないことを確認します。')
    let current: FakeChild | undefined
    const registry = createDevServerRegistry(makeDependencies({
      spawn: () => {
        current = makeFakeChild(558)
        return current.child
      },
      probe: () => {
        current?.writeStderr('warning: early from vite\n')
        current?.writeStderr(`${'x'.repeat(128 * 1024)}\n`)
        current?.exit()
        return Promise.resolve(false)
      },
    }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(String(dataOf(result)['log']).includes('early from vite')).toBe(false)
    expect(dataOf(result)['warnings']).toEqual(['early from vite'])
  })

  it('実行時依存を失っていても stop は通る', async () => {
    // 止めるのに @slidev/cli は要らない。ガードを停止の前に置くと、起動後に依存を失った
    // 環境で「動いているサーバを止められない」行き止まりになる。
    await explains('`slide_dev` ツールの停止のテストです。実行時依存が取得されていない状態でも、`stop` を指定した場合に停止でき、`slide.dev.stopped` と `stopped: true` を返すことを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(559).child }))
    await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)
    const tool = withOutputCheck(slideDevTool(() => registry, () => runtimeDependencies(false)))

    const result = await tool.handler({ dir: talkDirectory, stop: true }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.stopped', stopped: true })
  })

  it('stop は talk-dir の確認を通さずに停止する', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-04')
    // 停止は talk-dir の体裁と無関係で、消えた talk-dir のサーバも止められる必要がある。
    await explains('`slide_dev` ツールの停止のテストです。talk-dir が削除された後でも、`stop` を指定すると talk-dir を検証せず、サーバを止めて `slide.dev.stopped` を返すことを確認します。')
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(558).child }))
    const tool = toolWith(registry)
    await tool.handler({ dir: talkDirectory, stop: false }, CALL)
    rmSync(talkDirectory, { recursive: true })

    const result = await tool.handler({ dir: talkDirectory, stop: true }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toEqual({
      event: 'slide.dev.stopped',
      dir: talkDirectory,
      stopped: true,
      port: 3030,
    })
  })

  it('動いていないサーバへの stop は失敗にしない', async (context) => {
    await verifies(context, 'PV-SLIDE-DEV-05')
    await explains('`slide_dev` ツールの停止のテストです。動いていないサーバに `stop` を指定した場合に、エラーにせず、`slide.dev.stopped` と `stopped: false` を返すことを確認します。')
    const registry = createDevServerRegistry(makeDependencies())

    const result = await toolWith(registry).handler({ dir: talkDirectory, stop: true }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toEqual({ event: 'slide.dev.stopped', dir: talkDirectory, stopped: false })
  })
})
