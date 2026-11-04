// setup ツールのハンドラ単体テスト。
//
// tools/list 側の契約 (annotations・outputSchema・引数を取らないこと) は
// src/mcp/tests/contract.test.ts が持つ。ここは応答の中身だけを見る。
//
// 実取得は chromium が 120MB 級、実行時依存が 600MB 級のダウンロードなので deps を
// 差し替える。実ダウンロードを伴う確認は bootstrap CUJ (cli/tests/bootstrap/run.sh の
// CUJ 13) が持つ。

// SDK の CallToolResult は mutable メンバを持つ。
// そのため prefer-readonly-parameter-types は本ファイル全体で外す (src/mcp/tools/tests/slide.test.ts と同じ扱い)。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { describe, expect, it } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { SpawnResult } from '../../../domain/_shared/spawn-result.js'
import { LOCK_CONFLICT_EXIT_CODE } from '../../../infra/_shared/flock.js'
import type { RuntimeInstallResult } from '../../../infra/_shared/runtime-install.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import type { ToolCallContext } from '../../server.js'
import { setupTool } from '../setup.js'
import type { ChromiumDependencies, RuntimeDependencies } from '../_shared.js'
import type { HostDependencies } from '../../../infra/playwright/host-dependencies.js'

const CALL: ToolCallContext = { signal: new AbortController().signal }

const BROWSERS_ROOT = '/fake/ms-playwright'
const RUNTIME_ROOT = '/fake/pecotv-runtime'

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
data 直下の系統別サマリ (runtime / chromium)。
*/
function stageOf(result: Readonly<CallToolResult>, stage: 'runtime' | 'chromium' | 'hostDeps'): Record<string, unknown> {
  // eslint-disable-next-line security/detect-object-injection -- stage は本ファイル内の literal union
  const section = dataOf(result)[stage]
  if (!isRecord(section)) throw new Error(`data.${stage} が返っていません`)
  return section
}

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    // eslint-disable-next-line unicorn/no-null -- SpawnResult の signal は null を取る契約
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

/**
install() が成功したら取得済みに変わる deps。呼び出し回数と渡された signal も記録する。
*/
function fakeDependencies(options: Readonly<{
  installed: boolean
  install?: () => Promise<SpawnResult>
  browsersRoot?: () => string | undefined
}>): { deps: ChromiumDependencies, installCalls: () => number, installSignal: () => AbortSignal | undefined } {
  let isInstalled = options.installed
  let calls = 0
  let signal: AbortSignal | undefined
  const dependencies: ChromiumDependencies = {
    isInstalled: () => Promise.resolve(isInstalled),
    // setup は明示的な呼び出しなので opt-in の有無に関わらず取得する。
    isAutoInstallEnabled: () => false,
    browsersRoot: options.browsersRoot ?? (() => BROWSERS_ROOT),
    install: async (received?: AbortSignal) => {
      calls += 1
      signal = received
      const result = await (options.install?.() ?? Promise.resolve(spawnResult()))
      if (result.exitCode === 0) isInstalled = true
      return result
    },
  }
  return { deps: dependencies, installCalls: () => calls, installSignal: () => signal }
}

/**
実行時依存側の差し替え deps。既定は「取得済み」で chromium 側の観測を邪魔しない。
*/
function fakeRuntimeDependencies(options: Readonly<{
  installed?: boolean
  install?: () => Promise<RuntimeInstallResult>
  root?: () => string | undefined
}> = {}): { deps: RuntimeDependencies, installCalls: () => number, installSignal: () => AbortSignal | undefined } {
  let isInstalled = options.installed ?? true
  let calls = 0
  let signal: AbortSignal | undefined
  const dependencies: RuntimeDependencies = {
    isInstalled: () => isInstalled,
    root: options.root ?? (() => RUNTIME_ROOT),
    install: async (received?: AbortSignal) => {
      calls += 1
      signal = received
      const result = await (options.install?.() ?? Promise.resolve(spawnResult()))
      if (result.exitCode === 0) isInstalled = true
      return result
    },
  }
  return { deps: dependencies, installCalls: () => calls, installSignal: () => signal }
}

/**
OS ライブラリ確認の差し替え deps。既定は「起動できる」で chromium 側の観測を邪魔しない。
probes を順に返し、最後の値を繰り返す。記録の回数も数える。
*/
function fakeHostDependencies(options: Readonly<{
  probes?: readonly (string | undefined)[]
  sudoExitCode?: number
}> = {}): { deps: HostDependencies, records: () => string[], probeCalls: () => number, signals: () => (AbortSignal | undefined)[] } {
  const probes = [...(options.probes ?? [undefined])]
  const records: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  let probeCalls = 0
  const dependencies: HostDependencies = {
    platform: 'linux',
    isRoot: false,
    probe: () => {
      probeCalls += 1
      return Promise.resolve(probes.length > 1 ? probes.shift() : probes[0])
    },
    run: (command, arguments_, _timeoutMs, signal) => {
      signals.push(signal)
      if (arguments_.includes('--dry-run')) {
        return Promise.resolve(spawnResult({ stdout: 'Missing system dependencies (1):\n  libatk1.0-0t64\n' }))
      }
      if (command === 'sudo' && arguments_.join(' ') === '-n true') {
        return Promise.resolve(spawnResult({ exitCode: options.sudoExitCode ?? 0 }))
      }
      return Promise.resolve(spawnResult())
    },
    playwrightCli: () => '/pw/cli.js',
    nodePath: '/node',
    record: (status) => {
      records.push(status)
    },
    notify: () => {
      // MCP のルートでは通知しない (stdout は JSON-RPC 専有)
    },
  }
  return { deps: dependencies, records: () => records, probeCalls: () => probeCalls, signals: () => signals }
}

const LIBATK_FAILURE = 'browserType.launch: closed\n[err] /x/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file'

async function callSetup(
  dependencies: Readonly<ChromiumDependencies>,
  runtimeDependencies: Readonly<RuntimeDependencies> = fakeRuntimeDependencies().deps,
  hostDependencies: Readonly<HostDependencies> = fakeHostDependencies().deps,
): Promise<CallToolResult> {
  return await setupTool(() => dependencies, () => runtimeDependencies, () => hostDependencies).handler({}, CALL)
}

/**
setup の応答 data から `detail` を文字列で取り出す。
*/
async function setupDetail(...callArguments: Parameters<typeof callSetup>): Promise<string> {
  return String(dataOf(await callSetup(...callArguments))['detail'])
}

describe('setup: chromium', () => {
  it('未取得なら取得して成功を返す', async () => {
    const { deps, installCalls } = fakeDependencies({ installed: false })

    const result = await callSetup(deps)

    expect(result.isError).toBeUndefined()
    expect(installCalls()).toBe(1)
    const structured = structuredOf(result)
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    // 置いた実体の場所を成果物として返す。
    expect(structured['artifacts']).toEqual([BROWSERS_ROOT])
    expect(dataOf(result)['event']).toBe('setup.done')
    expect(stageOf(result, 'chromium')).toMatchObject({
      installed: true,
      downloaded: true,
      location: BROWSERS_ROOT,
    })
    expect(stageOf(result, 'chromium')['durationMs']).toEqual(expect.any(Number))
  })

  it('取得済みでも取得コマンドは実行し、ダウンロードなしとして返す', async () => {
    // 早期 return はしない。判定が「取得済み」でも実体が欠けていることがある。
    // 例はダウンロード途中、必要リビジョンだけ未取得の状態。
    // 早期 return は、取得と案内のどちらも行われない行き止まりを作る。
    // 取得済みなら Playwright 側が skip するので、実行してよい。
    const { deps, installCalls } = fakeDependencies({ installed: true })

    const result = await callSetup(deps)

    expect(result.isError).toBeUndefined()
    expect(installCalls()).toBe(1)
    expect(structuredOf(result)['artifacts'], '何も置いていないので成果物は無い').toEqual([])
    expect(dataOf(result)['event']).toBe('setup.skipped')
    expect(stageOf(result, 'chromium')).toMatchObject({ installed: true, downloaded: false })
  })

  it('呼び出し元の signal を取得コマンドへ渡す', async () => {
    // 接続していないと、クライアントがリクエストを打ち切っても子プロセスが動き続け、
    // 取得ロックを保持したままになる。
    const { deps, installSignal } = fakeDependencies({ installed: false })
    const runtime = fakeRuntimeDependencies({ installed: false })

    await callSetup(deps, runtime.deps)

    expect(installSignal()).toBe(CALL.signal)
    expect(runtime.installSignal(), '実行時依存の取得も同じ signal で打ち切れる').toBe(CALL.signal)
  })

  it('取得コマンドの stdout / stderr を両方載せる', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ stdout: 'Downloading Chromium', stderr: 'note' })),
    })

    const structured = structuredOf(await callSetup(deps))

    expect(structured['stdout']).toBe('Downloading Chromium')
    expect(structured['stderr']).toBe('note')
  })

  it('取得が失敗したら isError で原因と復旧手順を返す', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, stderr: 'ECONNREFUSED' })),
    })

    const result = await callSetup(deps)

    expect(result.isError).toBe(true)
    const structured = structuredOf(result)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)).toMatchObject({
      event: 'setup.error',
      reason: 'chromium-install-failed',
    })
    expect(stageOf(result, 'chromium')['installed']).toBe(false)
    // bin/pecotv の fatal メッセージと同じ誘導内容に揃える。
    const detail = String(dataOf(result)['detail'])
    expect(detail).toContain('HTTPS_PROXY')
    expect(detail).toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    expect(structured['stderr']).toBe('ECONNREFUSED')
  })

  it('タイムアウトはタイムアウトとして理由に出す', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, timedOut: true })),
    })

    expect(await setupDetail(deps)).toContain('タイムアウト')
  })

  it('exit 0 でも実体が置かれていなければ失敗として扱う', async () => {
    const dependencies: ChromiumDependencies = {
      isInstalled: () => Promise.resolve(false),
      isAutoInstallEnabled: () => false,
      browsersRoot: () => BROWSERS_ROOT,
      install: () => Promise.resolve(spawnResult()),
    }

    const result = await callSetup(dependencies)

    expect(result.isError).toBe(true)
    expect(String(dataOf(result)['detail'])).toContain(BROWSERS_ROOT)
  })

  it('browsers root を特定できなくても例外を出さずに返す', async () => {
    // PLAYWRIGHT_BROWSERS_PATH=0 のように場所を特定できない環境。
    // eslint-disable-next-line unicorn/no-useless-undefined -- browsersRoot は場所を特定できないとき undefined を返す契約
    const { deps } = fakeDependencies({ installed: false, browsersRoot: () => undefined })

    const result = await callSetup(deps)

    expect(result.isError).toBeUndefined()
    expect(structuredOf(result)['artifacts']).toEqual([])
    expect(stageOf(result, 'chromium')).not.toHaveProperty('location')
  })
})

describe('setup: 実行時依存 (永続層)', () => {
  it('未取得なら npm install を実行し、取得先を成果物に載せる', async () => {
    const runtime = fakeRuntimeDependencies({ installed: false })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(result.isError).toBeUndefined()
    expect(runtime.installCalls()).toBe(1)
    expect(structuredOf(result)['artifacts']).toEqual([RUNTIME_ROOT])
    expect(dataOf(result)['event']).toBe('setup.done')
    expect(stageOf(result, 'runtime')).toMatchObject({
      installed: true,
      downloaded: true,
      location: RUNTIME_ROOT,
    })
  })

  it('取得済みなら install を呼ばない', async () => {
    // chromium と違い install は 600MB 級の依存解決を毎回やり直すため、取得済みなら飛ばす。
    // プラグインルートは常にこのルートを通る (実行時依存が同梱されている)。
    const runtime = fakeRuntimeDependencies({ installed: true })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(runtime.installCalls()).toBe(0)
    expect(dataOf(result)['event']).toBe('setup.skipped')
    expect(stageOf(result, 'runtime')).toMatchObject({ installed: true, downloaded: false })
  })

  it('2 回続けて呼んでも 2 回目は取得しない (再入可能)', async () => {
    const runtime = fakeRuntimeDependencies({ installed: false })
    const chromium = fakeDependencies({ installed: false })
    const hostDependencies = fakeHostDependencies().deps
    const tool = setupTool(() => chromium.deps, () => runtime.deps, () => hostDependencies)

    await tool.handler({}, CALL)
    const second = await tool.handler({}, CALL)

    expect(runtime.installCalls(), '1 回目の取得で解決できるようになるため 2 回目は動かない').toBe(1)
    expect(stageOf(second, 'runtime')).toMatchObject({ installed: true, downloaded: false })
  })

  it('取得に失敗したら runtime-install-failed として返し、chromium は続行する', async () => {
    const runtime = fakeRuntimeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, stderr: 'ERR_PNPM' })),
    })
    const chromium = fakeDependencies({ installed: false })

    const result = await callSetup(chromium.deps, runtime.deps)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)).toMatchObject({ event: 'setup.error', reason: 'runtime-install-failed' })
    expect(String(dataOf(result)['detail'])).toContain('exit 1')
    expect(structuredOf(result)['stderr']).toBe('ERR_PNPM')
    // npm が破損している環境で chromium 取得まで巻き添えにしない。
    expect(chromium.installCalls()).toBe(1)
    expect(stageOf(result, 'chromium')['installed']).toBe(true)
    expect(structuredOf(result)['artifacts'], 'chromium 側は取得できたので成果物に残る').toEqual([BROWSERS_ROOT])
  })

  it('npm を起動できない場合も理由付きで返す', async () => {
    const runtime = fakeRuntimeDependencies({
      installed: false,
      // eslint-disable-next-line unicorn/no-null -- 起動失敗は exitCode: null で表す
      install: () => Promise.resolve(spawnResult({ exitCode: null, stderr: 'spawn npm ENOENT' })),
    })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(String(dataOf(result)['detail'])).toContain('npm を起動できませんでした')
  })

  it('exit 0 でも解決できなければ失敗として扱う', async () => {
    const runtime: RuntimeDependencies = {
      isInstalled: () => false,
      root: () => RUNTIME_ROOT,
      install: () => Promise.resolve(spawnResult()),
    }

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime)

    expect(result.isError).toBe(true)
    expect(String(dataOf(result)['detail'])).toContain(RUNTIME_ROOT)
  })

  it('タイムアウトと中断は原因を区別して返す', async () => {
    const timedOut = fakeRuntimeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, timedOut: true })),
    })
    const aborted = fakeRuntimeDependencies({
      installed: false,
      // eslint-disable-next-line unicorn/no-null -- 起動失敗は exitCode: null で表す
      install: () => Promise.resolve(spawnResult({ exitCode: null, signal: 'SIGTERM' })),
    })

    expect(await setupDetail(fakeDependencies({ installed: true }).deps, timedOut.deps))
      .toContain('タイムアウト')
    expect(await setupDetail(fakeDependencies({ installed: true }).deps, aborted.deps))
      .toContain('SIGTERM')
  })

  it('取得先を特定できなくても例外を出さずに返す', async () => {
    // HOME が無い環境では永続層の場所を決められない。
    const runtime = fakeRuntimeDependencies({
      installed: false,
      // eslint-disable-next-line unicorn/no-useless-undefined -- root は場所を特定できないとき undefined を返す契約
      root: () => undefined,
    })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(result.isError).toBeUndefined()
    expect(structuredOf(result)['artifacts'], '場所が分からないので成果物には出せない').toEqual([])
    expect(stageOf(result, 'runtime')).not.toHaveProperty('location')
  })

  it('ロック待ちの上限超過は「別プロセスが取得中」として返す', async () => {
    // 取得失敗と区別できないと、待てば済む状況で利用者が原因究明に入る。
    const runtime = fakeRuntimeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: LOCK_CONFLICT_EXIT_CODE })),
    })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(String(dataOf(result)['detail'])).toContain('別のプロセスが実行時依存を取得中')
  })
})

/**
実行時依存と chromium の両方が失敗する setup 呼び出し。
*/
function callSetupWithBothFailing(): Promise<CallToolResult> {
  const runtime = fakeRuntimeDependencies({
    installed: false,
    install: () => Promise.resolve(spawnResult({ exitCode: 1, stdout: 'npm-out', stderr: 'ERR_NPM' })),
  })
  const chromium: ChromiumDependencies = {
    isInstalled: () => Promise.resolve(false),
    isAutoInstallEnabled: () => false,
    browsersRoot: () => BROWSERS_ROOT,
    install: () => Promise.resolve(spawnResult({ exitCode: 1, stdout: 'pw-out', stderr: 'ECONNREFUSED' })),
  }
  return callSetup(chromium, runtime.deps)
}

describe('setup: TLS 証明書の検証で落ちた場合', () => {
  // SSL を中継するプロキシの CA が無いと TLS で落ちる。利用者が見るのは README ではなく setup の戻り値なので、
  // stderr が TLS の証明書検証の失敗を示すときだけ detail に分けの 1 文を足す。

  const TLS_HINT = 'NODE_EXTRA_CA_CERTS'

  it('実行時依存側: npm の検証コードを含む失敗には誘導が付く', async () => {
    const runtime = fakeRuntimeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stderr: 'npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      })),
    })

    const detail = await setupDetail(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(detail, '既存の理由は残す').toContain('npm install が exit 1')
    expect(detail).toContain('TLS 証明書の検証で失敗しています')
    expect(detail).toContain(TLS_HINT)
    expect(detail, '同梱の証明書は無い').not.toContain('同梱')
  })

  it('実行時依存側: TLS と無関係な失敗には誘導が付かない', async () => {
    const runtime = fakeRuntimeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, stderr: 'npm error code ECONNREFUSED' })),
    })

    const detail = await setupDetail(fakeDependencies({ installed: true }).deps, runtime.deps)

    expect(detail).toContain('npm install が exit 1')
    expect(detail).not.toContain(TLS_HINT)
  })

  it('chromium 側: playwright の文言を含む失敗には同じ誘導が付く', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stderr: 'Error: unable to verify the first certificate',
      })),
    })

    const detail = await setupDetail(deps)

    expect(detail, '既存の理由は残す').toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    expect(detail).toContain('TLS 証明書の検証で失敗しています')
    expect(detail).toContain(TLS_HINT)
  })

  it('chromium 側: TLS と無関係な失敗には誘導が付かない', async () => {
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({ exitCode: 1, stderr: 'ECONNREFUSED' })),
    })

    const detail = await setupDetail(deps)

    expect(detail).toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    expect(detail).not.toContain(TLS_HINT)
  })

  it('取得先 URL に cert の語が含まれるだけでは誘導が付かない', async () => {
    // `CERT` だけのような広い一致にすると、無関係な失敗まで TLS の問題に見せてしまう。
    const { deps } = fakeDependencies({
      installed: false,
      install: () => Promise.resolve(spawnResult({
        exitCode: 1,
        stderr: 'GET https://example.invalid/certs/chromium.zip failed: 404',
      })),
    })

    expect(await setupDetail(deps)).not.toContain(TLS_HINT)
  })
})

describe('setup: 両系統が失敗した場合', () => {
  // ネットワーク断・プロキシ誤設定では両方が落ちる。片方の理由しか message に載らないと、
  // 利用者は data.<系統>.detail を読み比べないと全体像が分からない。

  it('message と data.detail に両方の理由を載せる', async () => {
    const result = await callSetupWithBothFailing()

    expect(result.isError).toBe(true)
    const detail = String(dataOf(result)['detail'])
    expect(detail, '実行時依存側の理由').toContain('npm install が exit 1')
    expect(detail, 'chromium 側の理由').toContain('PLAYWRIGHT_DOWNLOAD_HOST')
    const message = String(structuredOf(result)['message'])
    expect(message).toContain('実行時依存')
    expect(message).toContain('Playwright Chromium')
  })

  it('reason は失敗した系統を全て並べる', async () => {
    expect(dataOf(await callSetupWithBothFailing())['reason'])
      .toBe('runtime-install-failed,chromium-install-failed')
  })

  it('両系統の stdout / stderr を落とさない', async () => {
    // ToolResult は stdout / stderr を 1 組しか持てないため連結する
    // (取得失敗の原因が stdout 側にあることもある)。
    const structured = structuredOf(await callSetupWithBothFailing())

    expect(String(structured['stderr'])).toContain('ERR_NPM')
    expect(String(structured['stderr'])).toContain('ECONNREFUSED')
    expect(String(structured['stdout'])).toContain('npm-out')
    expect(String(structured['stdout'])).toContain('pw-out')
  })

  it('取得できた実体が無いので artifacts は空', async () => {
    expect(structuredOf(await callSetupWithBothFailing())['artifacts']).toEqual([])
  })
})

describe('setup: Chromium の OS ライブラリ', () => {
  it('起動できれば何も入れずに成功を返し、確認に通ったことを記録する', async () => {
    const host = fakeHostDependencies()

    const result = await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(stageOf(result, 'hostDeps')).toMatchObject({ installed: true, downloaded: false })
    expect(host.records()).toEqual(['ok'])
  })

  it('足りなければ入れて成功を返し、入れたパッケージを message に載せる', async () => {
    const host = fakeHostDependencies({ probes: [LIBATK_FAILURE, undefined] })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    const structured = structuredOf(result)
    expect(structured['ok']).toBe(true)
    expect(String(structured['message'])).toContain('OS のライブラリを入れました')
    expect(String(structured['message'])).toContain('libatk1.0-0t64')
    expect(stageOf(result, 'hostDeps')).toMatchObject({ installed: true, downloaded: true })
    expect(host.records()).toEqual(['ok'])
  })

  it('OS ライブラリだけを入れた回は setup.skipped ではなく setup.done にする', async () => {
    const host = fakeHostDependencies({ probes: [LIBATK_FAILURE, undefined] })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    expect(dataOf(result)['event']).toBe('setup.done')
  })

  it('OS ライブラリの段にも call.signal を渡す', async () => {
    const host = fakeHostDependencies({ probes: [LIBATK_FAILURE, undefined] })

    await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    expect(host.signals().length).toBeGreaterThan(0)
    expect(host.signals().every(signal => signal === CALL.signal)).toBe(true)
  })

  it('sudo を使えなければ chromium-host-deps-missing として入れるコマンドを返す', async () => {
    const host = fakeHostDependencies({ probes: [LIBATK_FAILURE], sudoExitCode: 1 })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    const structured = structuredOf(result)
    expect(structured['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('chromium-host-deps-missing')
    expect(String(structured['message'])).toContain('sudo apt-get install -y --no-install-recommends libatk1.0-0t64')
    expect(String(structured['message']), '取得の失敗ではなく不足として、前置きなしで 1 回だけ案内する')
      .toMatch(/^Chromium の起動に要る OS のライブラリが足りません \(libatk-1\.0\.so\.0\)。(?!.*足りません)/)
    expect(String(structured['message'])).not.toContain('の取得に失敗しました')
    expect(host.records()).toEqual(['missing'])
  })

  it('起動の失敗が OS ライブラリ以外なら担当外として通し、理由を message と失敗の記録に残す', async () => {
    const host = fakeHostDependencies({ probes: ['browserType.launch: crashed'] })

    const result = await callSetup(fakeDependencies({ installed: true }).deps, fakeRuntimeDependencies().deps, host.deps)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(String(stageOf(result, 'hostDeps')['detail'])).toContain('browserType.launch: crashed')
    expect(String(structuredOf(result)['message'])).toContain('browserType.launch: crashed')
    expect(host.records()).toEqual(['launch-failed'])
  })

  it('Chromium の取得に失敗したら OS ライブラリの確認はしない', async () => {
    const host = fakeHostDependencies()
    const chromium = fakeDependencies({ installed: false, install: () => Promise.resolve(spawnResult({ exitCode: 1 })) })

    const result = await callSetup(chromium.deps, fakeRuntimeDependencies().deps, host.deps)

    expect(dataOf(result)['reason']).toBe('chromium-install-failed')
    expect(dataOf(result)['hostDeps']).toBeUndefined()
    expect(host.probeCalls()).toBe(0)
  })
})
