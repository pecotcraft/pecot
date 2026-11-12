/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは makeTemporaryDirectory の一時ディレクトリ配下のみ */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { resolveSessionDirectory } from '../session-directory.js'

function layout(): { readonly pluginRoot: string, readonly session: string, readonly project: string, readonly elsewhere: string } {
  const base = makeTemporaryDirectory()
  const directories = { pluginRoot: path.join(base, 'plugin'), session: path.join(base, 'session'), project: path.join(base, 'project'), elsewhere: path.join(base, 'elsewhere') }
  for (const directory of Object.values(directories)) mkdirSync(directory)
  return directories
}

describe('resolveSessionDirectory', () => {
  it('cwd がプラグインの root の中でなければ、変数に関わらず cwd のまま', () => {
    const { pluginRoot, session, elsewhere } = layout()
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, elsewhere)).toEqual({ kind: 'stay' })
  })

  it('CLAUDE_PLUGIN_ROOT が無い・空なら、cwd のまま', () => {
    const { session, elsewhere } = layout()
    expect(resolveSessionDirectory({ COPILOT_SESSION_CWD: session }, elsewhere)).toEqual({ kind: 'stay' })
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: '', COPILOT_SESSION_CWD: session }, elsewhere)).toEqual({ kind: 'stay' })
  })

  it('シェルから継いだ COPILOT_SESSION_CWD は、cwd がプラグインの root の外なら使わない', () => {
    const { pluginRoot, session } = layout()
    const inherited = { CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session, CLAUDE_PROJECT_DIR: session }
    expect(resolveSessionDirectory(inherited, session)).toEqual({ kind: 'stay' })
  })

  it('プラグインの root の中で COPILOT_SESSION_CWD が実在するディレクトリなら、そこへ移る', () => {
    const { pluginRoot, session, project } = layout()
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session, CLAUDE_PROJECT_DIR: project }, pluginRoot)).toEqual({
      kind: 'move',
      directory: session,
      variable: 'COPILOT_SESSION_CWD',
      value: session,
    })
  })

  it('cwd がプラグインの root の配下でも、移る', () => {
    const { pluginRoot, session } = layout()
    const nested = path.join(pluginRoot, 'cli-node')
    mkdirSync(nested)
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, nested)).toMatchObject({ kind: 'move', directory: session })
  })

  it('COPILOT_SESSION_CWD があるのにディレクトリが無ければ、CLAUDE_PROJECT_DIR があっても決められない', () => {
    const { pluginRoot, project } = layout()
    const missing = path.join(pluginRoot, 'missing')
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: missing, CLAUDE_PROJECT_DIR: project }, pluginRoot)).toEqual({
      kind: 'undetermined',
      reason: `cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: ${missing}`,
    })
  })

  it('ファイルを指す COPILOT_SESSION_CWD は、ディレクトリではないので決められない', () => {
    const { pluginRoot } = layout()
    const file = path.join(pluginRoot, '.mcp.json')
    writeFileSync(file, '{}')
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: file }, pluginRoot)).toMatchObject({ kind: 'undetermined' })
  })

  it('COPILOT_SESSION_CWD が無く、CLAUDE_PROJECT_DIR が実在するディレクトリなら、そこへ移る', () => {
    const { pluginRoot, project } = layout()
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project }, pluginRoot)).toEqual({
      kind: 'move',
      directory: project,
      variable: 'CLAUDE_PROJECT_DIR',
      value: project,
    })
  })

  it('COPILOT_SESSION_CWD が空文字なら無いものとして、CLAUDE_PROJECT_DIR を使う', () => {
    const { pluginRoot, project } = layout()
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: '', CLAUDE_PROJECT_DIR: project }, pluginRoot)).toMatchObject({ kind: 'move', directory: project })
  })

  it('CLAUDE_PROJECT_DIR があるのにディレクトリが無ければ、変数名と値を入れて決められない', () => {
    const { pluginRoot } = layout()
    const missing = path.join(pluginRoot, 'missing')
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: missing }, pluginRoot)).toEqual({
      kind: 'undetermined',
      reason: `cannot determine the target repository: CLAUDE_PROJECT_DIR is not a usable directory: ${missing}`,
    })
  })

  it('どちらの変数も無ければ（空文字を含む）、cwd を入れた理由で決められない', () => {
    const { pluginRoot } = layout()
    const reason = `cannot determine the target repository: the server was started in the plugin directory (${pluginRoot}) and the host passed no session directory (COPILOT_SESSION_CWD or CLAUDE_PROJECT_DIR); GitHub Copilot CLI passes it from 1.0.106`
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot }, pluginRoot)).toEqual({ kind: 'undetermined', reason })
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: '', CLAUDE_PROJECT_DIR: '' }, pluginRoot)).toEqual({ kind: 'undetermined', reason })
  })

  it('symlink 越しのプラグインの root でも、実体で比べて「中」と判定する', () => {
    const { pluginRoot, session, elsewhere } = layout()
    const link = path.join(elsewhere, 'plugin-link')
    symlinkSync(pluginRoot, link)
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: link, COPILOT_SESSION_CWD: session }, pluginRoot)).toMatchObject({ kind: 'move', directory: session })
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, link)).toMatchObject({ kind: 'move', directory: session })
  })

  it('相対パスの変数は、移る前の cwd を起点にして判定する', () => {
    const { pluginRoot } = layout()
    const nested = path.join(pluginRoot, 'cli-node')
    mkdirSync(path.join(pluginRoot, 'sessions', 'one'), { recursive: true })
    mkdirSync(nested)
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: '..', COPILOT_SESSION_CWD: '../sessions/one' }, nested)).toEqual({
      kind: 'move',
      directory: path.join(pluginRoot, 'sessions', 'one'),
      variable: 'COPILOT_SESSION_CWD',
      value: '../sessions/one',
    })
  })

  it('名前が前方一致するだけの兄弟のディレクトリは「中」ではない', () => {
    const { pluginRoot, session } = layout()
    const sibling = `${pluginRoot}-other`
    mkdirSync(sibling)
    expect(resolveSessionDirectory({ CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_SESSION_CWD: session }, sibling)).toEqual({ kind: 'stay' })
  })
})
