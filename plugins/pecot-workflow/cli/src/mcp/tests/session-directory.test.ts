/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは makeTemporaryDirectory の一時ディレクトリ配下のみ */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { resolveSessionDirectory } from '../session-directory.js'

function layout(): { readonly pluginRoot: string, readonly session: string, readonly project: string, readonly elsewhere: string } {
  const base = makeTemporaryDirectory()
  const directories = { pluginRoot: path.join(base, 'plugin'), session: path.join(base, 'session'), project: path.join(base, 'project'), elsewhere: path.join(base, 'elsewhere') }
  for (const directory of Object.values(directories)) mkdirSync(directory)
  return directories
}

describe('resolveSessionDirectory', () => {
  it('cwd がプラグインのルートの中でなければ、環境変数に関わらず cwd のままにする', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。作業ディレクトリがプラグインのルートの外にある場合は、環境変数の値に関わらず移動せず `stay` を返すことを確認します。')
    const { pluginRoot, session, elsewhere } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, elsewhere))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'stay' })
    })
  })

  it('CLAUDE_PLUGIN_ROOT が存在しない場合と空の場合は、cwd のままにする', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`CLAUDE_PLUGIN_ROOT` が設定されていない場合と空文字の場合に、移動せず `stay` を返すことを確認します。')
    const { session, elsewhere } = stepSync('ディレクトリの配置を用意する', () => layout())
    const unset = stepSync('CLAUDE_PLUGIN_ROOT が未設定でセッションのディレクトリを決める', () => resolveSessionDirectory({ COPILOT_SESSION_CWD: session }, elsewhere))
    const empty = stepSync('CLAUDE_PLUGIN_ROOT が空でセッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: '', COPILOT_SESSION_CWD: session }, elsewhere))
    stepSync('結果を比べる', () => {
      expect(unset).toEqual({ kind: 'stay' })
      expect(empty).toEqual({ kind: 'stay' })
    })
  })

  it('シェルから継いだ COPILOT_SESSION_CWD は、cwd がプラグインのルートの外なら使わない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。シェルから継いだ `COPILOT_SESSION_CWD` があっても、作業ディレクトリがプラグインのルートの外にある場合は、移動せず `stay` を返すことを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const inherited = { CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session, CLAUDE_PROJECT_DIR: session }
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory(inherited, session))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'stay' })
    })
  })

  it('プラグインのルートの中で COPILOT_SESSION_CWD が実在するディレクトリなら、そこへ移動する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。作業ディレクトリがプラグインのルートにあり、`COPILOT_SESSION_CWD` が実在するディレクトリの場合に、そのディレクトリへの `move` を返すことを確認します。')
    const { pluginRoot, session, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session, CLAUDE_PROJECT_DIR: project }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'move',
        directory: session,
        variable: 'COPILOT_SESSION_CWD',
        value: session,
      })
    })
  })

  it('cwd がプラグインのルートの配下でも、移動する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。作業ディレクトリがプラグインのルートの下のサブディレクトリにある場合でも、`COPILOT_SESSION_CWD` へ移動することを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const nested = path.join(pluginRoot, 'cli')
    stepSync('プラグインのルートの下にサブディレクトリを作る', () => {
      mkdirSync(nested)
    })
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, nested))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'move', directory: session })
    })
  })

  it('COPILOT_SESSION_CWD があってもディレクトリが存在しなければ、CLAUDE_PROJECT_DIR があっても決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` が存在しないディレクトリを指す場合に、`CLAUDE_PROJECT_DIR` があっても使わず、`undetermined` と理由を返すことを確認します。')
    const { pluginRoot, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const missing = path.join(pluginRoot, 'missing')
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: missing, CLAUDE_PROJECT_DIR: project }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'undetermined',
        reason: `cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: ${missing}`,
      })
    })
  })

  it('ファイルを指す COPILOT_SESSION_CWD は、ディレクトリではないので決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` がディレクトリでなくファイルを指す場合に、`undetermined` を返すことを確認します。')
    const { pluginRoot } = stepSync('ディレクトリの配置を用意する', () => layout())
    const file = path.join(pluginRoot, '.mcp.json')
    stepSync('ファイルを置く', () => {
      writeFileSync(file, '{}')
    })
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: file }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'undetermined' })
    })
  })

  it('COPILOT_SESSION_CWD が存在せず、CLAUDE_PROJECT_DIR が実在するディレクトリなら、そこへ移動する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` がなく、`CLAUDE_PROJECT_DIR` が実在するディレクトリの場合に、そのディレクトリへの `move` を返すことを確認します。')
    const { pluginRoot, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'move',
        directory: project,
        variable: 'CLAUDE_PROJECT_DIR',
        value: project,
      })
    })
  })

  it('COPILOT_SESSION_CWD が空文字なら未設定として扱い、CLAUDE_PROJECT_DIR を使う', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` が空文字の場合に、未設定として扱い、`CLAUDE_PROJECT_DIR` へ移動することを確認します。')
    const { pluginRoot, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: '', CLAUDE_PROJECT_DIR: project }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'move', directory: project })
    })
  })

  it('CLAUDE_PROJECT_DIR があってもディレクトリが存在しなければ、変数名と値を含めて決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`CLAUDE_PROJECT_DIR` が存在しないディレクトリを指す場合に、変数名と値を含む理由とともに `undetermined` を返すことを確認します。')
    const { pluginRoot } = stepSync('ディレクトリの配置を用意する', () => layout())
    const missing = path.join(pluginRoot, 'missing')
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: missing }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'undetermined',
        reason: `cannot determine the target repository: CLAUDE_PROJECT_DIR is not a usable directory: ${missing}`,
      })
    })
  })

  it('どちらの変数も存在しなければ（空文字を含む）、cwd を含めた理由で決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` と `CLAUDE_PROJECT_DIR` がどちらも未設定か空文字の場合は、作業ディレクトリを含む理由と `undetermined` を返すことを確認します。')
    const { pluginRoot } = stepSync('ディレクトリの配置を用意する', () => layout())
    const reason = `cannot determine the target repository: the server was started in the plugin directory (${pluginRoot}) and the host passed no session directory (COPILOT_SESSION_CWD); upgrade GitHub Copilot CLI to 1.0.106 or later, or start the server in the target repository`
    const result = stepSync('変数が未設定でセッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot }, pluginRoot))
    stepSync('未設定の場合の結果を比べる', () => {
      expect(result).toEqual({ kind: 'undetermined', reason })
    })
    const emptyResult = stepSync('空文字の変数でセッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: '', CLAUDE_PROJECT_DIR: '' }, pluginRoot))
    stepSync('空文字の場合の結果を比べる', () => {
      expect(emptyResult).toEqual({ kind: 'undetermined', reason })
    })
  })

  it('COPILOT_PLUGIN_ROOT があるとき（Copilot CLI の起動）は、継いだ CLAUDE_PROJECT_DIR を使わず決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_PLUGIN_ROOT` の設定時は、継いだ `CLAUDE_PROJECT_DIR` を使わず、更新の案内を理由にして `undetermined` を返すことを確認します。')
    const { pluginRoot, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result.kind).toBe('undetermined')
      expect(JSON.stringify(result)).toContain('upgrade GitHub Copilot CLI to 1.0.106 or later')
    })
  })

  it('COPILOT_PLUGIN_ROOT があっても、COPILOT_SESSION_CWD が実在すれば、そこへ移動する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_PLUGIN_ROOT` が設定されていても、`COPILOT_SESSION_CWD` が実在するディレクトリなら、そのディレクトリへ移動することを確認します。')
    const { pluginRoot, session, project } = stepSync('ディレクトリの配置を用意する', () => layout())
    const environment = { CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session, CLAUDE_PROJECT_DIR: project }
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory(environment, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'move', directory: session })
    })
  })

  it('PLUGIN_ROOT だけがあっても、cwd がその中なら、COPILOT_SESSION_CWD へ移動する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`PLUGIN_ROOT` だけが設定され、作業ディレクトリがその中にある場合は、`COPILOT_SESSION_CWD` へ移動し、それも未設定なら `undetermined` を返すことを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'move', directory: session })
    })
    const unset = stepSync('COPILOT_SESSION_CWD が未設定でセッションのディレクトリを決める', () => resolveSessionDirectory({ PLUGIN_ROOT: pluginRoot }, pluginRoot))
    stepSync('未設定の場合の結果を比べる', () => {
      expect(unset).toMatchObject({ kind: 'undetermined' })
    })
  })

  it('PLUGIN_ROOT だけがあって、cwd がその外なら、cwd のままにする', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`PLUGIN_ROOT` だけが設定され、作業ディレクトリがその外にある場合は、移動せず `stay` を返すことを確認します。')
    const { pluginRoot, session, elsewhere } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, elsewhere))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'stay' })
    })
  })

  it('2 つの変数のうち一方の中にあれば、プラグインのルートの中と判定する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`CLAUDE_PLUGIN_ROOT` と `PLUGIN_ROOT` のうち一方のディレクトリの中に作業ディレクトリがある場合に、プラグインのルートの中と判定して移動することを確認します。')
    const { pluginRoot, session, elsewhere } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: elsewhere, PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toMatchObject({ kind: 'move' })
    })
  })

  it('相対パスのセッションのディレクトリが存在しなければ、解決後の絶対パスを理由に含める', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`COPILOT_SESSION_CWD` が存在しない相対パスの場合に、元の値と解決後の絶対パスを含む理由とともに `undetermined` を返すことを確認します。')
    const { pluginRoot } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: 'missing' }, pluginRoot))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'undetermined',
        reason: `cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: missing (resolved to ${path.join(pluginRoot, 'missing')})`,
      })
    })
  })

  it.skipIf(process.getuid?.() === 0)('実体のパスを解決できない（権限がない）ときは、cwd のままにせず、パスと元の失敗を理由にして決められない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。作業ディレクトリの実体のパスを権限がなく解決できない場合に、`stay` にせず、そのパスと元の失敗を含む理由とともに `undetermined` を返すことを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const locked = path.join(pluginRoot, 'locked')
    stepSync('権限のないディレクトリを用意する', () => {
      mkdirSync(path.join(locked, 'inner'), { recursive: true })
      chmodSync(locked, 0)
    })
    try {
      const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, path.join(locked, 'inner')))
      stepSync('結果を比べる', () => {
        expect(result.kind).toBe('undetermined')
        expect(JSON.stringify(result)).toContain(`cannot determine the target repository: cannot resolve the real path of ${path.join(locked, 'inner')}: `)
      })
    }
    finally {
      chmodSync(locked, 0o700)
    }
  })

  it('cwd がプラグインのルートの親にあるときは、cwd のままにする', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。作業ディレクトリがプラグインのルートの親にある場合は、移動せず `stay` を返すことを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, path.dirname(pluginRoot)))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'stay' })
    })
  })

  it('シンボリックリンク越しのプラグインのルートでも、実体で比較して中と判定する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。プラグインのルートか作業ディレクトリのどちらかがシンボリックリンクの場合でも、実体のパスで比較して中と判定し、移動することを確認します。')
    const { pluginRoot, session, elsewhere } = stepSync('ディレクトリの配置を用意する', () => layout())
    const link = path.join(elsewhere, 'plugin-link')
    stepSync('プラグインのルートへのシンボリックリンクを置く', () => {
      symlinkSync(pluginRoot, link)
    })
    const viaRoot = stepSync('リンク越しのルートでセッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: link, COPILOT_SESSION_CWD: session }, pluginRoot))
    const viaCwd = stepSync('リンク越しの cwd でセッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, link))
    stepSync('結果を比べる', () => {
      expect(viaRoot).toMatchObject({ kind: 'move', directory: session })
      expect(viaCwd).toMatchObject({ kind: 'move', directory: session })
    })
  })

  it('相対パスの環境変数は、移動する前の cwd を起点にして判定する', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。`CLAUDE_PLUGIN_ROOT` と `COPILOT_SESSION_CWD` が相対パスの場合に、作業ディレクトリを起点に解決し、絶対パスのディレクトリへ移動することを確認します。')
    const { pluginRoot } = stepSync('ディレクトリの配置を用意する', () => layout())
    const nested = path.join(pluginRoot, 'cli')
    stepSync('セッションのディレクトリとサブディレクトリを作る', () => {
      mkdirSync(path.join(pluginRoot, 'sessions', 'one'), { recursive: true })
      mkdirSync(nested)
    })
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: '..', COPILOT_SESSION_CWD: '../sessions/one' }, nested))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({
        kind: 'move',
        directory: path.join(pluginRoot, 'sessions', 'one'),
        variable: 'COPILOT_SESSION_CWD',
        value: '../sessions/one',
      })
    })
  })

  it('名前が前方一致するだけの兄弟のディレクトリは、プラグインのルートの中と判定しない', async () => {
    await explains('MCP サーバーが使うセッションのディレクトリを決める `resolveSessionDirectory` のテストです。プラグインのルートと名前が前方一致するだけの兄弟のディレクトリで実行した場合に、中と判定せず `stay` を返すことを確認します。')
    const { pluginRoot, session } = stepSync('ディレクトリの配置を用意する', () => layout())
    const sibling = `${pluginRoot}-other`
    stepSync('名前が前方一致する兄弟のディレクトリを作る', () => {
      mkdirSync(sibling)
    })
    const result = stepSync('セッションのディレクトリを決める', () => resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, sibling))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ kind: 'stay' })
    })
  })
})
