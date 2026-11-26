// コマンドが error の行を出して止める処理と、対象のリポから設定を選ぶ処理。全コマンドが共有する。
import { z } from 'zod'

import type { ProjectConfig } from '../domain/config.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { ambiguousMessage, configLookupFailure, findConfigFor, listProjectConfigNames, loadActiveConfig, loadNamedConfig, unknownProjectMessage } from '../infra/config-store.js'
import type { FoundConfig } from '../infra/config-store.js'
import { CommandExit } from './command-definition.js'
import { commandHint, hinted, placeholder, RUN_COLON } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import type { FailureKind } from './failure-kind.js'
import type { Output } from './output.js'

/**
アクティブなプロジェクトが無いときの案内
*/
export const NO_ACTIVE_PROJECT: HintedText = hinted`no active project\n${RUN_COLON}${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`

/**
error の行を出して、原因の名前と指定の終了コード（既定は 1）で止める
*/
export function stopWith(out: Readonly<Output>, message: string | HintedText, kind: FailureKind, code = 1): never {
  out.error(message)
  throw new CommandExit(code, kind)
}

/**
アクティブなプロジェクトの設定を読む。無ければ案内付きの NO_ACTIVE_PROJECT を error の行にして止める
*/
export function requireActiveConfig(out: Readonly<Output>): ProjectConfig {
  return loadActiveConfig() ?? stopWith(out, NO_ACTIVE_PROJECT, 'no-active-project')
}

/**
対象のリポから設定を選ぶ `project` の入力。board sync の `project` と同じ名前の読み方
*/
export const PROJECT_INPUT = z.string().optional().describe('Name of the project config under .pecot/config/projects (without .json). Without it, the config that includes the target repository; when several do, the active one among them')

/**
対象のリポから設定を選ぶ（findConfigFor）。選べなければ、configLookupFailure の文を error の行にして止める
*/
export function requireConfigFor(out: Readonly<Output>, target: Readonly<RepositoryReference>, project: string | undefined, commandPath: readonly string[]): FoundConfig {
  const lookup = findConfigFor(target, project)
  if (lookup.kind === 'found') return lookup.found
  const { message, kind } = configLookupFailure(lookup, target, commandPath)
  return stopWith(out, message, kind)
}

/**
対象のリポを持たない、ボード全体の操作の設定。project、次にアクティブ設定。どちらも無く設定が 1 つだけなら、それを使う
*/
export function requireBoardConfig(out: Readonly<Output>, project: string | undefined, commandPath: readonly string[]): ProjectConfig {
  if (project !== undefined) return loadNamedConfig(project)?.config ?? stopWith(out, unknownProjectMessage(project), 'project-not-found')
  const active = loadActiveConfig()
  if (active !== undefined) return active
  const names = listProjectConfigNames()
  const [only] = names
  if (only === undefined) return stopWith(out, NO_ACTIVE_PROJECT, 'no-active-project')
  if (names.length === 1) return loadNamedConfig(only)?.config ?? stopWith(out, NO_ACTIVE_PROJECT, 'no-active-project')
  return stopWith(out, ambiguousMessage(`no active project, and ${String(names.length)} project configs exist`, names, commandPath), 'no-active-project')
}
