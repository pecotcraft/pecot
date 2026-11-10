/* eslint-disable security/detect-non-literal-fs-filename -- パスはプロジェクトルート配下の設定ディレクトリと、呼び出し側が渡す設定ファイル */
// プロジェクト設定（`.pecot/config/projects/*.json`）の読み書き。モデルと判定は domain/config.ts にある。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  ConfigError,
  findRepositoryByName,
  MultipleConfigsError,
  parseProjectConfig,
  serializeProjectConfig,
} from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { parseJsonText } from '../domain/json.js'
import { compareStrings, pythonStrip } from '../domain/python-format.js'
import { isFileNotFound } from './os-error.js'
import { CONFIG_DIR, projectRoot, resolveRealPath } from './paths.js'
import { readTextFile } from './text-file.js'

/**
設定ディレクトリ（`{プロジェクトルート}/.pecot/config`）
*/
export function configDirectory(): string {
  return path.join(projectRoot(), CONFIG_DIR)
}

/**
プロジェクト設定ディレクトリ（`.pecot/config/projects`）
*/
export function projectsDirectory(): string {
  return path.join(configDirectory(), 'projects')
}

/**
JSON ファイルから設定を読む。無ければ ConfigError、形が不正なら検証エラー
*/
export function loadConfig(file: string): ProjectConfig {
  if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`)
  return parseProjectConfig(parseJsonText(readTextFile(file)))
}

/**
設定を JSON ファイルに保存する。親ディレクトリが無ければ作る
*/
export function saveConfig(config: ProjectConfig, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, serializeProjectConfig(config))
}

/**
.active ファイルが指すアクティブ設定のパス。中身は .active のあるディレクトリ基準の相対パス（絶対パスも可）。
設定されていない・指す先が無いときは undefined
*/
export function getActiveConfigPath(): string | undefined {
  const activeFile = path.join(projectsDirectory(), '.active')
  if (!existsSync(activeFile)) return undefined
  const raw = pythonStrip(readTextFile(activeFile))
  if (raw === '') return undefined
  const configPath = resolveRealPath(path.resolve(path.dirname(activeFile), raw))
  return existsSync(configPath) ? configPath : undefined
}

export function loadActiveConfig(): ProjectConfig | undefined {
  const configPath = getActiveConfigPath()
  return configPath === undefined ? undefined : loadConfig(configPath)
}

/**
アクティブ設定を設定する。.active には .active のあるディレクトリ基準の相対パスを書く。ファイルが無ければ ConfigError
*/
export function setActiveConfig(file: string): void {
  if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`)
  const activeFile = path.join(projectsDirectory(), '.active')
  mkdirSync(path.dirname(activeFile), { recursive: true })
  const relative = path.relative(path.resolve(path.dirname(activeFile)), path.resolve(file))
  writeFileSync(activeFile, `${relative}\n`)
}

export interface FindConfigOptions {
  readonly host?: string | undefined
  readonly owner?: string | undefined
}

/**
`{host}_{owner}_*.json` の設定ファイルを探す（プロジェクト名ベース）。host と owner の両方が要る。
複数見つかったら MultipleConfigsError（名前順）
*/
export function findConfigFile(options: Readonly<FindConfigOptions>): string | undefined {
  const { host, owner } = options
  if (host === undefined || host === '' || owner === undefined || owner === '') return undefined
  const directory = projectsDirectory()
  const prefix = `${host}_${owner}_`
  let names: readonly string[]
  try {
    names = readdirSync(directory)
  }
  catch (error: unknown) {
    if (isFileNotFound(error)) return undefined
    throw error
  }
  const matches = names.filter(name => name.startsWith(prefix) && name.endsWith('.json') && name.length >= prefix.length + '.json'.length).toSorted(compareStrings)
  const [only] = matches
  if (matches.length > 1) throw new MultipleConfigsError(matches.map(name => path.join(directory, name)))
  return only === undefined ? undefined : path.join(directory, only)
}

export interface ProjectConfigQuery extends FindConfigOptions {
  /**
  リポジトリ名（owner なし）。アクティブ設定の repositories に含まれるかを先に確かめる
  */
  readonly repository?: string | undefined
}

/**
プロジェクト設定を取得する。引数なしはアクティブ設定。
repository だけなら、アクティブ設定の repositories にあればそれを返し、無ければ検索する。見つからなければ undefined
*/
export function getProjectConfig(query: Readonly<ProjectConfigQuery> = {}): ProjectConfig | undefined {
  const { host, owner, repository } = query
  if (host === undefined && owner === undefined && repository === undefined) return loadActiveConfig()

  if (host === undefined && owner === undefined && repository !== undefined) {
    const active = loadActiveConfig()
    if (active !== undefined && findRepositoryByName(active, repository) !== undefined) return active
  }

  const configPath = findConfigFile({ host, owner })
  return configPath === undefined ? undefined : loadConfig(configPath)
}
