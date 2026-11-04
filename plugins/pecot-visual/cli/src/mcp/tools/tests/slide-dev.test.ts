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
import type { EnsureThemeLinked } from '../slide-dev.js'
import type { RuntimeDependencies } from '../_shared.js'

const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<CallToolResult>): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
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

  it('預かっていた子が死んでいたら起こし直す', async () => {
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

  it('ポートを奪われて即死したら次の候補で張り直す', async () => {
    // slidev は --port 明示時 strictPort で動くため、塞がっていれば自動採番せず即 exit 1 する。
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

  it('既定のポートは 3030 から 3034 まで', () => {
    expect(devServerDefaultDependencies().defaultPorts).toEqual([3030, 3031, 3032, 3033, 3034])
  })

  it('ポートの指定が無ければ既定のポートを小さい順に試し、最初の空きで起動する', async () => {
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
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: () => Promise.resolve(false) }))

    const started = await registry.start(TALK_DIRECTORY)

    expect(started.ok ? '' : started.detail).toContain('確認してから呼び直して')
  })

  it('指定されたポートで起動する', async () => {
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

  it('指定されたポートが使用中なら別のポートへ移らず失敗を返す', async () => {
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
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: port => Promise.resolve(port !== 5000) }))

    const started = await registry.start(TALK_DIRECTORY, { port: 5000 })

    expect(started.ok ? '' : started.detail).toContain('確認してから呼び直して')
  })

  it('指定されたポートを起動直前に奪われたら、捕捉した出力を添えて失敗を返す', async () => {
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

  it('ready にならなければタイムアウトで畳んで子を止める', async () => {
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
    const fake = makeFakeChild(17)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)
    fake.exit()

    const stopped = registry.stop(TALK_DIRECTORY)

    expect(stopped).toEqual({ stopped: false, port: undefined })
    expect(fake.killedWith, '死んだ子へシグナルは撃たない').toEqual([])
  })

  it('SIGTERM で終わらない子は SIGKILL へ上げる', async () => {
    const fake = makeFakeChild(13)
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    registry.stop(TALK_DIRECTORY)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })

    expect(fake.killedWith).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('kill が失敗しても停止要求は落ちない', async () => {
    const fake = makeFakeChild(14, { killThrows: true })
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => fake.child }))
    await registry.start(TALK_DIRECTORY)

    expect(registry.stop(TALK_DIRECTORY)).toEqual({ stopped: true, port: 3030 })
  })

  it('shutdown は預かっている全てのサーバを止める', async () => {
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
      throw new Error('ツールは実行時依存を取得しない (取得は setup ツールの責務)')
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
  return slideDevTool(() => registry, installedRuntimeDependencies, () => ensureThemeLinked)
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
    const registry = createDevServerRegistry(makeDependencies())

    expect(await registry.stopAndWait(TALK_DIRECTORY)).toEqual({ stopped: false, port: undefined })
  })

  it('SIGTERM を無視して生き続ける子でも、待ちを打ち切って戻る', async () => {
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

  it('相対パスは実処理前に exitCode 2 で弾く', async () => {
    const result = await toolWith(unusedRegistry()).handler({ dir: 'relative/deck', stop: false }, CALL)

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)).toHaveProperty('invalidPaths')
  })

  it('talk-dir が無ければ spawn せず即失敗し、捕捉相当の空キーを残す', async () => {
    const result = await toolWith(unusedRegistry()).handler(
      { dir: path.join(workDirectory, 'no-such-deck'), stop: false },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('talk-dir-not-found')
    expect(structuredOf(result)['stdout']).toBe('')
    expect(structuredOf(result)['stderr']).toBe('')
  })

  it('slides.md が無ければ Slidev プロジェクトとして扱わない', async () => {
    rmSync(path.join(talkDirectory, 'slides.md'))

    const result = await toolWith(unusedRegistry()).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(dataOf(result)['reason']).toBe('slides-md-not-found')
  })

  it('node_modules を解決できなければ slide_sync を案内する', async () => {
    // 実環境では talk-dir/node_modules は依存ルートへの symlink で、切れると vite が
    // 不明瞭な失敗をする。start.mjs と同じ案内を spawn 前に返す。
    rmSync(path.join(talkDirectory, 'node_modules'), { recursive: true })

    const result = await toolWith(unusedRegistry()).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(dataOf(result)['reason']).toBe('node-modules-unresolved')
    expect(String(dataOf(result)['detail'])).toContain('`slide_sync`')
  })

  it('既定の張り直しは、テーマを参照しない talk-dir (slides.md に theme が無い) を theme-none で止める', async () => {
    // 3 つ目の引数を省き、既定の ensureTalkThemeLinked (実ファイルを読む) を通す。
    const tool = slideDevTool(() => unusedRegistry(), installedRuntimeDependencies)

    const result = await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('theme-none')
  })

  it('テーマの取得に失敗したら、原因ごとの reason と文言で止まり、spawn しない', async () => {
    const failure = new ThemeFetchError('テーマの取得元 https://example.com/x.git にタグ \'v9.9.9\' がありません。タグ名を確認してください。', 'tag')

    const result = await toolWith(unusedRegistry(), () => Promise.reject(failure)).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(dataOf(result)['event']).toBe('slide.dev.error')
    expect(dataOf(result)['reason']).toBe('theme-tag')
    expect(String(dataOf(result)['detail'])).toContain('タグ名を確認してください')
  })

  it('テーマを参照しない talk-dir (移行前の形) は theme-none で止まる', async () => {
    const failure = new ThemeResolveError('テーマを参照していません。slide sync --theme を実行してください', 'theme-none')

    const result = await toolWith(unusedRegistry(), () => Promise.reject(failure)).handler(
      { dir: talkDirectory, stop: false },
      CALL,
    )

    expect(dataOf(result)['reason']).toBe('theme-none')
  })

  it('テーマの張り直しは node_modules の確認より前に行う (張り直しで復旧できる状態を拒まない)', async () => {
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

  it('MCP のキャンセルの signal と警告の出力先を、テーマの取得へ渡し、警告を data.warnings に載せる', async () => {
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

  it('テーマの取得に失敗したときも、取得中の警告を data.warnings に残す', async () => {
    const result = await toolWith(unusedRegistry(), failingAfterWarning).handler({ dir: talkDirectory, stop: false }, CALL)

    expect(dataOf(result)['reason']).toBe('theme-connection')
    expect(dataOf(result)['warnings']).toEqual(['取得中の警告'])
  })

  it('張り直しが無ければ、起動済みのサーバを止めずに再利用へ進む', async () => {
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

  it('起動できたら URL・ポート・pid を data に載せる', async () => {
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
    expect(String(structuredOf(result)['message'])).toContain('http://localhost:3030')
  })

  it('port を指定したらそのポートで起動する', async () => {
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(560).child }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, port: 5000, stop: false }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.started', port: 5000, url: 'http://localhost:5000' })
  })

  it('指定した port が使用中なら理由付きで失敗を返す', async () => {
    const registry = createDevServerRegistry(makeDependencies({ isPortFree: () => Promise.resolve(false) }))

    const result = await toolWith(registry).handler({ dir: talkDirectory, port: 5000, stop: false }, CALL)

    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('dev-server-port-in-use')
    expect(String(structuredOf(result)['message'])).toContain('5000')
  })

  it.each([0, 65_536, 3030.5])('ポートとして成り立たない port (%s) は受け付けない', async (port) => {
    // 投げられるのが schema.parse (parsePathArguments) の ZodError であること、拒否した先が
    // port であることまで見る。rejects.toThrow() だけでは、別の理由で reject しても通ってしまう。
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

  it('起動済みなら reused として同じ URL を返す', async () => {
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(556).child }))
    const tool = toolWith(registry)
    await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    const result = await tool.handler({ dir: talkDirectory, stop: false }, CALL)

    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.reused', reused: true, port: 3030 })
  })

  it('起動に失敗したら捕捉した出力を添えて返す', async () => {
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
    expect(dataOf(result)['reason']).toBe('dev-server-exited')
    expect(String(structuredOf(result)['stderr'])).toContain('起動に失敗')
  })

  it('実行時依存を失っていても stop は通る', async () => {
    // 止めるのに @slidev/cli は要らない。ガードを停止の前に置くと、起動後に依存を失った
    // 環境で「動いているサーバを止められない」行き止まりになる。
    const registry = createDevServerRegistry(makeDependencies({ spawn: () => makeFakeChild(559).child }))
    await toolWith(registry).handler({ dir: talkDirectory, stop: false }, CALL)
    const tool = slideDevTool(() => registry, () => runtimeDependencies(false))

    const result = await tool.handler({ dir: talkDirectory, stop: true }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toMatchObject({ event: 'slide.dev.stopped', stopped: true })
  })

  it('stop は talk-dir の確認を通さずに停止する', async () => {
    // 停止は talk-dir の体裁と無関係で、消えた talk-dir のサーバも止められる必要がある。
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

  it('動いていないサーバへの stop は失敗にしない', async () => {
    const registry = createDevServerRegistry(makeDependencies())

    const result = await toolWith(registry).handler({ dir: talkDirectory, stop: true }, CALL)

    expect(result.isError).toBeUndefined()
    expect(dataOf(result)).toEqual({ event: 'slide.dev.stopped', dir: talkDirectory, stopped: false })
  })
})
