// @pecot/workflow-core の dataDirectory を、このプラグインの bin/_lib.sh と照らす。
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { dataDirectory } from '@pecot/workflow-core/infra/paths.js'
import { attachOutput } from '../../../../../../libs/interface-spec/src/vitest/attach.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { pluginRoot } from '../../version.js'
import { explains } from '../../../tests/_helpers/explains.js'

useIsolatedEnvironment()

describe('dataDirectory は bin/_lib.sh の plugin_data_dir_resolve と同じ結果になる', () => {
  const libraryPath = path.join(pluginRoot(), 'bin', '_lib.sh')
  const callFunction = path.join(import.meta.dirname, '../../tests/_helpers/call-bash-function.sh')
  const PROJECT_NAME = 'pecot-workflow'

  /**
  bash で plugin_data_dir_resolve を呼ぶ。データ置き場の 3 変数・XDG_DATA_HOME・HOME を消してから values を設定する
  */
  function bashResolve(values: Readonly<Record<string, string>>): { readonly stdout: string, readonly status: number | null } {
    const environment: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...values }
    const result = spawnSync('bash', [callFunction, libraryPath, 'plugin_data_dir_resolve', PROJECT_NAME], { env: environment, encoding: 'utf8' })
    attachOutput('bash plugin_data_dir_resolve', result.status ?? undefined, result.stdout, result.stderr)
    return { stdout: result.stdout, status: result.status }
  }

  const CASES: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['CLAUDE_PLUGIN_DATA が絶対パス', { CLAUDE_PLUGIN_DATA: '/data/claude', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の改行は落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\n\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA の末尾の CR も落とす', { CLAUDE_PLUGIN_DATA: '/data/claude\r\n', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が相対パスなら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: 'relative/dir', PLUGIN_DATA: '/data/plugin', HOME: '/home/u' }],
    ['CLAUDE_PLUGIN_DATA が変数展開の書式なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: '/data/plugin' }],
    ['CLAUDE_PLUGIN_DATA が空なら PLUGIN_DATA', { CLAUDE_PLUGIN_DATA: '', PLUGIN_DATA: '/data/plugin' }],
    ['PLUGIN_DATA だけ', { PLUGIN_DATA: '/data/plugin', XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が絶対パス', { XDG_DATA_HOME: '/xdg', HOME: '/home/u' }],
    ['XDG_DATA_HOME が相対パスなら HOME', { XDG_DATA_HOME: 'xdg', HOME: '/home/u' }],
    ['HOME だけ', { HOME: '/home/u' }],
    ['HOME の末尾の改行は落とす', { HOME: '/home/u\n' }],
    ['HOME が相対パスなら解決できない', { HOME: 'relative' }],
    ['HOME が変数展開の書式なら解決できない', { HOME: '${HOME}' }],
    ['何も無ければ解決できない', {}],
    ['空白を含むパスは trim しない', { CLAUDE_PLUGIN_DATA: '/data/with space ' }],
  ]

  it.each(CASES)('%s の場合は、bash と同じ場所を返す', async (_name, values) => {
    await explains('データ置き場を求める `dataDirectory` のテストです。環境変数の組み合わせごとに、`bin/_lib.sh` の `plugin_data_dir_resolve` と同じ場所（解決できない場合は `undefined`）を返すことを確認します。')
    const expected = bashResolve(values)
    // 未設定にした上で設定する（テストの env を bash に渡した env と一致させる）
    setEnvironment({ CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined, XDG_DATA_HOME: undefined, HOME: undefined })
    setEnvironment(values)
    const expectedDirectory = expected.status === 0 ? expected.stdout.replace(/\n$/u, '') : undefined
    expect(dataDirectory()).toBe(expectedDirectory)
  })

  it('bash の解決結果が実際に得られる（テストの前提）', async () => {
    await explains('上のテストの前提を確認するテストです。`HOME` だけを設定して `plugin_data_dir_resolve` を呼んだ場合に、`/home/u/.local/share/pecot/pecot-workflow` が返ることを確認します。')
    const stdout = execFileSync('bash', [callFunction, libraryPath, 'plugin_data_dir_resolve', PROJECT_NAME], { env: { PATH: process.env['PATH'] ?? '', HOME: '/home/u' }, encoding: 'utf8' })
    attachOutput('bash plugin_data_dir_resolve', 0, stdout, '')
    expect(stdout)
      .toBe(`/home/u/.local/share/pecot/${PROJECT_NAME}\n`)
  })
})
