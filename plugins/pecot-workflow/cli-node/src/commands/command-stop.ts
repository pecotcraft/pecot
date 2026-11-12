// コマンドが error の行を出して止める処理。全コマンドが共有する。
import type { ProjectConfig } from '../domain/config.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { CommandExit } from './command-definition.js'
import type { Output } from './output.js'

/**
アクティブなプロジェクトが無いときの 1 行だけの案内
*/
export const NO_ACTIVE_PROJECT_SHORT = 'no active project'

/**
アクティブなプロジェクトが無いときの案内
*/
export const NO_ACTIVE_PROJECT = 'no active project\nrun: pecot project activate <PROJECT>'

/**
error の行を出して、指定の終了コード（既定は 1）で止める
*/
export function stopWith(out: Readonly<Output>, message: string, code = 1): never {
  out.error(message)
  throw new CommandExit(code)
}

/**
アクティブなプロジェクトの設定を読む。無ければ message（既定は案内付きの NO_ACTIVE_PROJECT）を error の行にして止める
*/
export function requireActiveConfig(out: Readonly<Output>, message = NO_ACTIVE_PROJECT): ProjectConfig {
  return loadActiveConfig() ?? stopWith(out, message)
}
