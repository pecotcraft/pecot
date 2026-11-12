// tech-advisor-clone-allow コアスクリプトと claude-bash-guards 経由の自動許可のテスト。
// w-tech-advisor の定型 clone だけが、自動許可（core は exit 10、adapters は allow JSON）になる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig, claudeProjectDirectory } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { adapterDirectory, coreDirectory } from '../_helpers/paths.js'
import { run, runHookScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const ENVELOPE_CMD = 'git clone --depth 1 https://github.com/foo/bar .pecot/work/788/tech-advisor/bar'
const ALLOW_SCRIPT = path.join(coreDirectory, 'tech-advisor-clone-allow.sh')
const CLAUDE_BASH_GUARDS_SCRIPT = path.join(adapterDirectory, 'claude-bash-guards.sh')

function runCore(hookCase: HookCase, command: string, extraEnvironment: EnvironmentOverrides = {}): RunResult {
  return run(hookCase, 'bash', [ALLOW_SCRIPT], { env: { HOOK_COMMAND: command, ...extraEnvironment } })
}

function runAdapter(hookCase: HookCase, stdin: string): RunResult {
  return runHookScript(hookCase, CLAUDE_BASH_GUARDS_SCRIPT, stdin)
}

function copilotStdin(command: string): string {
  return jsonDumps({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
}

// hooks-config を空の設定で用意する。
function setUpCore(hookCase: HookCase): void {
  hooksConfig(hookCase).write({})
}

describe('tech-advisor-clone-allow.sh', () => {
  describe('core: 定型の clone を許可する', () => {
    it('https の URL を渡すと、exit 10 で自動許可の文言を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, ENVELOPE_CMD)
      expect(result.exitCode).toBe(10)
      expect(result.stdout).toContain('allowed automatically')
    })

    it('git@ 形式の URL を渡すと、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, 'git clone git@github.com:foo/bar.git .pecot/work/12/tech-advisor/bar')
      expect(result.exitCode).toBe(10)
    })

    it('オプションが無いとき、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, 'git clone https://github.com/foo/bar .pecot/work/3/tech-advisor/bar')
      expect(result.exitCode).toBe(10)
    })

    it('末尾のスラッシュと名前のドットがあっても、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, 'git clone https://github.com/foo/bar.js .pecot/work/788/tech-advisor/bar.js/')
      expect(result.exitCode).toBe(10)
    })

    it('等号つきのオプションでも、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const command = 'git clone --depth=1 --branch=v1.0 https://github.com/foo/bar .pecot/work/788/tech-advisor/bar'
      const result = runCore(hookCase, command)
      expect(result.exitCode).toBe(10)
    })
  })

  describe('core: 許可リスト内のオプション', () => {
    it.for([
      { label: '--branch の空白区切り', command: 'git clone --branch main https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--single-branch', command: 'git clone --single-branch https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--no-tags', command: 'git clone --no-tags https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--quiet', command: 'git clone --quiet https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--filter の等号つき', command: 'git clone --filter=blob:none https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--filter の空白区切り', command: 'git clone --filter tree:0 https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--depth と --single-branch の併用', command: 'git clone --depth 1 --single-branch https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
    ])('許可リスト内のオプション（$label）を付けても、exit 10 を返す', (row) => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, row.command)
      expect(result.exitCode).toBe(10)
    })
  })

  describe('core: 許可リスト外のオプション', () => {
    it.for([
      { label: '--upload-pack', command: 'git clone --upload-pack=/bin/sh https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--template', command: 'git clone --template=/etc/passwd https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--separate-git-dir', command: 'git clone --separate-git-dir=/tmp/x https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '--recurse-submodules', command: 'git clone --recurse-submodules https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
      { label: '許可リストにない --verbose', command: 'git clone --verbose https://github.com/foo/bar .pecot/work/788/tech-advisor/bar' },
    ])('許可リスト外のオプション（$label）を付けると、許可せず何も出力しない', (row) => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, row.command)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('core: clone 先の書き方', () => {
    it('clone 先が ./ で始まるとき、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, 'git clone https://github.com/foo/bar ./.pecot/work/788/tech-advisor/bar')
      expect(result.exitCode).toBe(10)
    })

    it('clone 先がプロジェクト配下の絶対パスのとき、exit 10 を返す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const command = 'git clone https://github.com/foo/bar /workspaces/proj/.pecot/work/788/tech-advisor/bar'
      const result = runCore(hookCase, command, { HOOK_WORKING_DIR: '/workspaces/proj' })
      expect(result.exitCode).toBe(10)
    })

    it('clone 先がプロジェクトの外の絶対パスのとき、許可せず何も出力しない', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const command = 'git clone https://github.com/foo/bar /tmp/.pecot/work/788/tech-advisor/bar'
      const result = runCore(hookCase, command, { HOOK_WORKING_DIR: '/workspaces/proj' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('core: 定型の外', () => {
    it.for([
      { label: 'clone 先が tech-advisor 配下でない', command: 'git clone https://github.com/foo/bar .pecot/work/788/lib/bar' },
      { label: 'clone 先が /tmp 配下', command: 'git clone https://github.com/foo/bar /tmp/bar' },
      { label: 'clone 先が相対の名前だけ', command: 'git clone https://github.com/foo/bar bar' },
      { label: '&& でコマンドを連結している', command: `${ENVELOPE_CMD} && rm -rf important` },
      { label: '; でコマンドを連結している', command: 'git clone https://github.com/foo/bar .pecot/work/788/tech-advisor/bar; ls' },
      { label: 'コマンド置換を含む', command: 'git clone $(echo url) .pecot/work/788/tech-advisor/bar' },
      { label: 'clone 先に .. を含む', command: 'git clone https://github.com/foo/bar .pecot/work/788/tech-advisor/../escape' },
      { label: 'Issue 番号が数字でない', command: 'git clone https://github.com/foo/bar .pecot/work/abc/tech-advisor/bar' },
      { label: 'clone 以外のコマンド', command: 'git checkout main' },
    ])('コマンドが定型の外（$label）のとき、許可せず何も出力しない', (row) => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, row.command)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('コマンドが複数行のとき、許可せず何も出力しない', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, `${ENVELOPE_CMD}\nrm -rf important`)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('core: HOOK_COMMAND と設定', () => {
    it('HOOK_COMMAND が空文字のとき、exit 2 で必須の旨を stderr に出す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = runCore(hookCase, '')
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('HOOK_COMMAND environment variable is required')
    })

    it('HOOK_COMMAND が未設定のとき、exit 2 で必須の旨を stderr に出す', () => {
      const hookCase = createHookCase()
      setUpCore(hookCase)
      const result = run(hookCase, 'bash', [ALLOW_SCRIPT], { env: { HOOK_COMMAND: undefined } })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('HOOK_COMMAND environment variable is required')
    })

    it('設定で無効にしたとき、許可せず何も出力しない', () => {
      const hookCase = createHookCase()
      hooksConfig(hookCase).write({ 'tech-advisor-clone-allow': false })
      const result = runCore(hookCase, ENVELOPE_CMD)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('claude-bash-guards: allow JSON と deny ガード', () => {
    it('定型の clone のとき、allow を返す', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, jsonDumps({ tool_input: { command: ENVELOPE_CMD } }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"permissionDecision": "allow"')
      expect(result.stdout).toContain('"hookEventName": "PreToolUse"')
    })

    it('--no-verify つきの commit のとき、deny が優先され allow は出ない', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, jsonDumps({ tool_input: { command: 'git commit --no-verify -m x' } }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"permissionDecision": "deny"')
      expect(result.stdout).not.toContain('"permissionDecision": "allow"')
    })

    it('無害なコマンドのとき、何も出力しない', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, jsonDumps({ tool_input: { command: 'ls -la' } }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('定型の形に && が付くと、allow が出ない', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, jsonDumps({ tool_input: { command: `${ENVELOPE_CMD} && rm -rf important` } }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('permissionDecision')
    })
  })

  describe('Copilot CLI の snake_case の入力', () => {
    it('定型の clone のとき、allow を返す', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, copilotStdin(ENVELOPE_CMD))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"permissionDecision": "allow"')
    })

    it('--no-verify つきの commit のとき、deny が優先される', () => {
      const hookCase = createHookCase()
      claudeProjectDirectory(hookCase)
      setUpCore(hookCase)
      const result = runAdapter(hookCase, copilotStdin('git commit --no-verify -m x'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"permissionDecision": "deny"')
    })
  })
})
