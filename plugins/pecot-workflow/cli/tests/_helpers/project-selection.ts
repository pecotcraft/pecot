// 対象のリポから設定を選ぶテストの準備。.active を空にし、同じ内容の 2 つ目の設定（second）を足す。
import { projectConfigFiles } from './workspace.js'

const PROJECTS = '.pecot/config/projects'

export const SECOND_PROJECT = 'second'

/**
runCommand の files 用。.active を空にする（アクティブなプロジェクトが無い）
*/
export const NO_ACTIVE_FILES: Readonly<Record<string, string>> = { [`${PROJECTS}/.active`]: '' }

export const AMBIGUOUS_MESSAGE = 'ghes.example.com_acme_board_acme, second'

/**
openWorkspace の files 用。projectConfigFiles の設定を second としても置き、.active を空にする
*/
export function ambiguousWorkspaceFiles(): Readonly<Record<string, string>> {
  const content = Object.entries(projectConfigFiles()).find(([file]) => file.endsWith('.json'))?.at(1) ?? ''
  return { ...NO_ACTIVE_FILES, [`${PROJECTS}/${SECOND_PROJECT}.json`]: content }
}
