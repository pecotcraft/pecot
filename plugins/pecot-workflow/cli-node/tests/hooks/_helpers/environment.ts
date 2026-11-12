/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
// ケースごとの env と一時ディレクトリ。createHookCase は it の中で 1 回呼び、後始末は afterEach が行う。
// setEnv は子に渡す env だけを上書きし、process.env は書き換えない。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach } from 'vitest'

import { jsonDumps } from './text.js'

// pre-push・pre-commit 配下の git が export する変数。素の git が実リポに書くのを防ぐため、setup.ts が外す。
export const GIT_ENV_LEAK_KEYS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
]

export const PLUGIN_ENV_LEAK_KEYS: readonly string[] = ['PLUGIN_DATA', 'PECOT_BOOTSTRAP_SKIP', 'PECOT_BOOTSTRAP_FORCE']

export type EnvironmentOverrides = Readonly<Record<string, string | undefined>>

export interface HookCase {
  readonly temporaryPath: string
  readonly pluginData: string
  setEnv(name: string, value: string | undefined): void
  getEnv(name: string): string | undefined
  composeEnv(overrides?: EnvironmentOverrides): NodeJS.ProcessEnv
}

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeTemporaryDirectory(prefix: string): string {
  const fresh = mkdtempSync(path.join(tmpdir(), prefix))
  const directory = realpathSync(fresh)
  created.push(directory)
  return directory
}

// undefined の値は外す。
function applyOverrides(base: Readonly<NodeJS.ProcessEnv>, overrides: EnvironmentOverrides): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(result, name)
    else Reflect.set(result, name, value)
  }
  return result
}

export function createHookCase(): HookCase {
  const temporaryPath = makeTemporaryDirectory('pecot-hooks-')
  const pluginData = makeTemporaryDirectory('pecot-hooks-plugin-data-')
  const overrides = new Map<string, string | undefined>()
  return {
    temporaryPath,
    pluginData,
    setEnv(name, value) {
      overrides.set(name, value)
    },
    getEnv(name) {
      return overrides.has(name) ? overrides.get(name) : Reflect.get(process.env, name)
    },
    composeEnv(extra = {}) {
      const base = applyOverrides({ ...process.env, CLAUDE_PLUGIN_DATA: pluginData }, Object.fromEntries(overrides))
      return applyOverrides(base, extra)
    },
  }
}

const scratchDirectories = new WeakMap<HookCase, string>()

// テストが中身を見ない一時ディレクトリ。ケースの temporaryPath を汚さないために分ける。
export function scratchDirectory(hookCase: HookCase): string {
  const existing = scratchDirectories.get(hookCase)
  if (existing !== undefined) return existing
  const directory = makeTemporaryDirectory('pecot-hooks-scratch-')
  scratchDirectories.set(hookCase, directory)
  return directory
}

// CLAUDE_PROJECT_DIR を tmp/project に向け、project/.pecot を作る。
export function claudeProjectDirectory(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(path.join(project, '.pecot'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return project
}

export interface HooksConfig {
  readonly path: string
  write(config: unknown): void
}

// PECOT_HOOKS_CONFIG_PATH を tmp/hooks-config.json に向ける。
export function hooksConfig(hookCase: HookCase): HooksConfig {
  const file = path.join(hookCase.temporaryPath, 'hooks-config.json')
  hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', file)
  return {
    path: file,
    write(config) {
      writeFileSync(file, jsonDumps(config))
    },
  }
}
