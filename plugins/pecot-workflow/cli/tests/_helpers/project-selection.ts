// 対象のリポから設定を選ぶテストの準備。.active を外す・同じ内容の 2 つ目の設定（second）を足す。
import { copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { projectConfig } from './command-harness.js'
import type { ProjectFixture } from './interface-case.js'
import { projectConfigFiles } from './workspace.js'

const PROJECTS = '.pecot/config/projects'

export const SECOND_PROJECT = 'second'

/**
アクティブなプロジェクトの指定（.active）を外す
*/
export function removeActive(project: Readonly<ProjectFixture>): void {
  rmSync(path.join(project.root, PROJECTS, '.active'))
}

/**
同じリポを含む 2 つ目の設定（second）を足し、.active を外す。対象のリポで選ぶ設定が 1 つに決まらない
*/
export function makeAmbiguous(project: Readonly<ProjectFixture>): void {
  const directory = path.join(project.root, PROJECTS)
  copyFileSync(path.join(directory, project.configFile), path.join(directory, `${SECOND_PROJECT}.json`))
  removeActive(project)
}

/**
runCommand の files 用。.active を空にする（アクティブなプロジェクトが無い）
*/
export const NO_ACTIVE_FILES: Readonly<Record<string, string>> = { [`${PROJECTS}/.active`]: '' }

/**
runCommand の files 用。同じ設定を second として足し、.active を空にする。対象のリポで選ぶ設定が 1 つに決まらない
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
