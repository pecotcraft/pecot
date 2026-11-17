/* eslint-disable security/detect-non-literal-fs-filename -- パスはプロジェクトルート配下の設定ディレクトリと、呼び出し側が渡す設定ファイル */
// プロジェクト設定（`.pecot/config/projects/*.json`）の読み書き。モデルと判定は domain/config.ts にある。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ConfigError, findRepository, parseProjectConfig, serializeProjectConfig } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { InvalidValueError } from '../domain/errors.js'
import { parseJsonText } from '../domain/json.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { compareStrings, pythonStrip, ValidationFailure } from '../domain/python-format.js'
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

// 設定の値から、読んだファイルの実パスを引く。書き込みの失敗の案内（project activate <名前>）に使う
const SOURCE_PATHS = new WeakMap<ProjectConfig, string>()

/**
loadConfig で読んだ設定のファイルの実パス。ファイルから読んでいない設定は undefined
*/
export function configSourcePath(config: ProjectConfig): string | undefined {
  return SOURCE_PATHS.get(config)
}

/**
JSON ファイルから設定を読む。無ければ ConfigError、JSON の構文や形が不正なら `invalid config file: {パス}: {詳細}` の ConfigError。
詳細は、形の不正なら `場所: 本文` を `; ` でつないだもの（Python と同じ）、構文の不正なら JSON パーサーの文（Python の JSONDecodeError の文とは違う）
*/
export function loadConfig(file: string): ProjectConfig {
  if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`)
  try {
    const config = parseProjectConfig(parseJsonText(readTextFile(file)))
    SOURCE_PATHS.set(config, resolveRealPath(file))
    return config
  }
  catch (error: unknown) {
    if (error instanceof ValidationFailure) {
      const detail = error.issues.map(issue => `${issue.location.map(String).join('.')}: ${issue.message}`).join('; ')
      throw new ConfigError(`invalid config file: ${file}: ${detail}`, { cause: error })
    }
    if (error instanceof InvalidValueError) throw new ConfigError(`invalid config file: ${file}: ${error.message}`, { cause: error })
    throw error
  }
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
projects/ にある設定の名前（拡張子 .json を除く。名前順）。ディレクトリが無ければ空
*/
export function listProjectConfigNames(): readonly string[] {
  try {
    return readdirSync(projectsDirectory()).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).toSorted(compareStrings)
  }
  catch (error: unknown) {
    if (isFileNotFound(error)) return []
    throw error
  }
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

/**
設定と、その名前・実パス。name は projects/ の中なら拡張子を除いたファイル名、外ならパス（project activate に渡せる形）
*/
export interface FoundConfig {
  readonly name: string
  readonly path: string
  readonly config: ProjectConfig
}

/**
project activate に渡せる設定の名前。projects/ の中なら拡張子を除いたファイル名、外ならパスそのもの
*/
export function projectNameOf(configPath: string): string {
  return path.dirname(configPath) === resolveRealPath(projectsDirectory()) ? path.basename(configPath, '.json') : configPath
}

function foundAt(file: string): FoundConfig {
  const config = loadConfig(file)
  const realPath = configSourcePath(config) ?? resolveRealPath(file)
  return { name: projectNameOf(realPath), path: realPath, config }
}

/**
projects/ の設定を名前で読む。`.json` は省ける。その名前の設定が無ければ undefined
*/
export function loadNamedConfig(name: string): FoundConfig | undefined {
  // 一覧は projects/ の *.json の名前なので、一致すれば ../ などの外のパスにならない
  const bare = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
  return listProjectConfigNames().includes(bare) ? foundAt(path.join(projectsDirectory(), `${bare}.json`)) : undefined
}

/**
設定が対象のリポを含むか。repositories にあるか、aggregation_repo と一致すれば含む（aggregation_repo は repositories に無くてよい）
*/
export function hasRepository(config: ProjectConfig, target: Readonly<RepositoryReference>): boolean {
  return findRepository(config, target.owner, target.repository) !== undefined || config.aggregation_repo === `${target.owner}/${target.repository}`
}

/**
対象のリポを含む設定（projects/ の *.json と、.active の指す設定）。名前順。形の誤った設定は、関係が無くても ConfigError
*/
export function findConfigsForRepository(target: Readonly<RepositoryReference>): readonly FoundConfig[] {
  const all = listProjectConfigNames().map(name => foundAt(path.join(projectsDirectory(), `${name}.json`)))
  const active = getActiveConfigPath()
  if (active !== undefined && all.every(found => found.path !== active)) all.push(foundAt(active))
  return all.filter(found => hasRepository(found.config, target))
}

export type ConfigLookup
  = | { readonly kind: 'found', readonly found: FoundConfig }
    | { readonly kind: 'none' }
    | { readonly kind: 'ambiguous', readonly candidates: readonly FoundConfig[] }
    | { readonly kind: 'unknown-project', readonly project: string }
    | { readonly kind: 'not-in-project', readonly found: FoundConfig }

/**
対象のリポから設定を決める。project を渡せばその名前の設定、無ければ対象のリポを含む設定。
候補が 2 つ以上なら、.active の指す設定が候補にあればそれを使う
*/
export function findConfigFor(target: Readonly<RepositoryReference>, project?: string): ConfigLookup {
  if (project !== undefined && project !== '') {
    const named = loadNamedConfig(project)
    if (named === undefined) return { kind: 'unknown-project', project }
    return hasRepository(named.config, target) ? { kind: 'found', found: named } : { kind: 'not-in-project', found: named }
  }
  const candidates = findConfigsForRepository(target)
  const [only] = candidates
  if (only === undefined) return { kind: 'none' }
  if (candidates.length === 1) return { kind: 'found', found: only }
  const active = getActiveConfigPath()
  const chosen = candidates.find(found => found.path === active)
  return chosen === undefined ? { kind: 'ambiguous', candidates } : { kind: 'found', found: chosen }
}
