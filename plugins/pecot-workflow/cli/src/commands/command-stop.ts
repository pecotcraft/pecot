// コマンドが error の行を出して止める処理。全コマンドが共有する。
import type { ProjectConfig } from '../domain/config.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { CommandExit } from './command-definition.js'
import { commandHint, hinted, placeholder } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import type { FailureKind } from './failure-kind.js'
import type { Output } from './output.js'

/**
アクティブなプロジェクトが無いときの、案内を添えない文
*/
const NO_ACTIVE_PROJECT_PLAIN = 'no active project'

/**
アクティブなプロジェクトが無いときの案内
*/
export const NO_ACTIVE_PROJECT: HintedText = hinted`no active project\nrun: ${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`

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
requireActiveConfig の、案内を添えない形。無ければ NO_ACTIVE_PROJECT_PLAIN を error の行にして止める
*/
export function requireActiveConfigPlain(out: Readonly<Output>): ProjectConfig {
  return loadActiveConfig() ?? stopWith(out, NO_ACTIVE_PROJECT_PLAIN, 'no-active-project')
}
