// `pecotv chromium host-deps` の単体テスト。結果ごとの文言・exit code・記録の有無を見る。
// 判定と導入の本体 (infra/playwright/host-dependencies.ts) は差し替え、実 Chromium と apt-get は起動しない。

import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { SpawnResult } from '../../../domain/_shared/spawn-result.js'
import type { HostDependencies } from '../../../infra/playwright/host-dependencies.js'
import { createChromiumHostDependenciesCommand, HOST_DEPS_MISSING_EXIT_CODE, LAUNCH_FAILED_EXIT_CODE } from '../host-dependencies.js'

const LIBATK_FAILURE = 'browserType.launch: closed\n[err] /x/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file'

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  // eslint-disable-next-line unicorn/no-null -- SpawnResult は signal 無しを null で表す
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

async function runCommand(options: Readonly<{
  probes: readonly (string | undefined)[]
  sudoExitCode?: number
  arguments_?: readonly string[]
}>): Promise<{
  stderr: string
  exitCode: number | undefined
  records: string[]
}> {
  const probes = [...options.probes]
  const records: string[] = []
  let exitCode: number | undefined
  const stderr = new PassThrough()
  stderr.setEncoding('utf8')
  let written = ''
  stderr.on('data', (chunk: string) => {
    written += chunk
  })
  const hostDependencies: HostDependencies = {
    platform: 'linux',
    isRoot: false,
    probe: () => Promise.resolve(probes.length > 1 ? probes.shift() : probes[0]),
    run: (command, arguments_) => {
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
      throw new Error('コマンドは notify を stderr に差し替えるので、ここは呼ばれない')
    },
  }
  const command = createChromiumHostDependenciesCommand(() => ({
    hostDeps: () => hostDependencies,
    stderr,
    setExitCode: (code) => {
      exitCode = code
    },
  }))
  await command.parseAsync([...(options.arguments_ ?? [])], { from: 'user' })
  return { stderr: written, exitCode, records }
}

describe('pecotv chromium host-deps', () => {
  it('起動できれば何も出さずに記録する', async () => {
    await expect(runCommand({ probes: [undefined] })).resolves.toEqual({ stderr: '', exitCode: undefined, records: ['ok'] })
  })

  it('入れたら入れたパッケージを出して記録する', async () => {
    const result = await runCommand({ probes: [LIBATK_FAILURE, undefined] })
    expect(result.stderr).toContain('added: libatk1.0-0t64\n')
    expect(result.exitCode).toBeUndefined()
    expect(result.records).toEqual(['ok'])
  })

  it('apt-get を始める前に、何を入れるかを stderr に出す', async () => {
    const result = await runCommand({ probes: [LIBATK_FAILURE, undefined] })
    expect(result.stderr).toMatch(/^note: .*apt-get で入れます/)
    expect(result.stderr.indexOf('apt-get で入れます')).toBeLessThan(result.stderr.indexOf('added: '))
  })

  it('入れられなければ入れるコマンドを出し、exit 2 で失敗として記録する', async () => {
    const result = await runCommand({ probes: [LIBATK_FAILURE], sudoExitCode: 1 })
    expect(result.stderr).toMatch(/^error: /)
    expect(result.stderr).toContain('sudo apt-get install -y --no-install-recommends libatk1.0-0t64')
    expect(result.exitCode).toBe(HOST_DEPS_MISSING_EXIT_CODE)
    expect(result.records).toEqual(['missing'])
  })

  it('OS ライブラリ以外の起動失敗は理由を出して通し、失敗として記録する', async () => {
    const result = await runCommand({ probes: ['browserType.launch: Executable doesn\'t exist at /x/chrome'] })
    expect(result.stderr).toMatch(/^warning: .*OS のライブラリ以外の原因/)
    expect(result.exitCode).toBeUndefined()
    expect(result.records).toEqual(['launch-failed'])
  })

  it('--require-launch では OS ライブラリ以外の起動失敗も exit 3 にする', async () => {
    const result = await runCommand({ probes: ['browserType.launch: Executable doesn\'t exist at /x/chrome'], arguments_: ['--require-launch'] })
    expect(result.stderr).toMatch(/^error: .*OS のライブラリ以外の原因/)
    expect(result.exitCode).toBe(LAUNCH_FAILED_EXIT_CODE)
    expect(result.records).toEqual(['launch-failed'])
  })

  it('--require-launch でも起動できれば成功のまま記録する', async () => {
    await expect(runCommand({ probes: [undefined], arguments_: ['--require-launch'] })).resolves.toEqual({ stderr: '', exitCode: undefined, records: ['ok'] })
  })
})
