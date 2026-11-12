/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// hooks のシェルスクリプトを子プロセスで起動する。
// 利用者の環境の設定とフラグを読まないよう、cwd と CLAUDE_PROJECT_DIR を一時ディレクトリにし、環境変数は要るものだけを渡す。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { onTestFinished } from 'vitest'

const hooksDirectory = path.resolve(import.meta.dirname, '../../../../hooks')

export interface HookRun {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
}

export interface RunHookOptions {
  readonly projectDirectory: string
  readonly stdin?: string
  readonly env?: Readonly<Record<string, string>>
}

// テストごとの一時プロジェクト（CLAUDE_PROJECT_DIR）。テストの終わりに消す。
export function createProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'hooks-test-'))
  mkdirSync(path.join(directory, '.pecot', 'state'), { recursive: true })
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

export function writeStateFlag(projectDirectory: string, name: string): void {
  writeFileSync(path.join(projectDirectory, '.pecot', 'state', name), '')
}

// 設定ファイルは一時プロジェクトの直下に置き、PECOT_HOOKS_CONFIG_PATH で指す。書かなければ既定値で動く。
export function writeHooksConfig(projectDirectory: string, config: Readonly<Record<string, boolean>>): void {
  writeFileSync(path.join(projectDirectory, 'hooks-config.json'), JSON.stringify(config))
}

// script は hooks/ からの相対パス。
export function runHook(script: string, options: Readonly<RunHookOptions>): HookRun {
  const result = spawnSync('bash', [path.join(hooksDirectory, script)], {
    input: options.stdin ?? '',
    cwd: options.projectDirectory,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: options.projectDirectory,
      CLAUDE_PROJECT_DIR: options.projectDirectory,
      PECOT_HOOKS_CONFIG_PATH: path.join(options.projectDirectory, 'hooks-config.json'),
      ...options.env,
    },
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}
