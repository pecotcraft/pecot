// runCommand で、対象のリポから設定を選ぶテストの準備。files で .active を空にする・同じ内容の 2 つ目の設定を足す。
import { projectConfig } from './command-harness.js'
import { projectConfigFiles } from './workspace.js'

const PROJECTS = '.pecot/config/projects'

export const SECOND_PROJECT = 'second'

/**
.active を空にする（アクティブなプロジェクトが無い）
*/
export const NO_ACTIVE_FILES: Readonly<Record<string, string>> = { [`${PROJECTS}/.active`]: '' }

/**
同じ設定を second として足し、.active を空にする。対象のリポで選ぶ設定が 1 つに決まらない
*/
export function ambiguousFiles(config: Readonly<Record<string, unknown>> = projectConfig()): Readonly<Record<string, string>> {
  return { ...NO_ACTIVE_FILES, [`${PROJECTS}/${SECOND_PROJECT}.json`]: `${JSON.stringify(config, undefined, 2)}\n` }
}

export const AMBIGUOUS_MESSAGE = 'ghes.example.com_acme_board_acme, second'

/**
対象の acme/demo を含まない設定
*/
export function otherRepositoryConfig(): Record<string, unknown> {
  return projectConfig({ repositories: [{ owner: 'acme', name: 'other', develop_branch: 'main' }] })
}

/**
openWorkspace の files 用。projectConfigFiles の設定を second としても置き、.active を空にする
*/
export function ambiguousWorkspaceFiles(): Readonly<Record<string, string>> {
  const content = Object.entries(projectConfigFiles()).find(([file]) => file.endsWith('.json'))?.at(1) ?? ''
  return { ...NO_ACTIVE_FILES, [`${PROJECTS}/${SECOND_PROJECT}.json`]: content }
}
