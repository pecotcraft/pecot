// コマンドが error の行を出して止める処理。project と branch のコマンドが共有する。
import type { ProjectConfig } from '../domain/config.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { CommandExit } from './command-definition.js'
import type { Output } from './output.js'

/**
使い方の誤り（コマンドの引数の形）の終了コード
*/
export const USAGE_EXIT = 2

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
アクティブなプロジェクトの設定を読む。無ければ error の行を出して止める
*/
export function requireActiveConfig(out: Readonly<Output>): ProjectConfig {
  return loadActiveConfig() ?? stopWith(out, NO_ACTIVE_PROJECT)
}
