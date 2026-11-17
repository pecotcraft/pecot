// 対象のリポから設定を選ぶテストの準備。.active を外す・同じ内容の 2 つ目の設定を足す。
import { copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import type { ProjectFixture } from './interface-case.js'

export const SECOND_CONFIG = 'second'

/**
アクティブなプロジェクトの指定（.active）を外す
*/
export function removeActive(project: Readonly<ProjectFixture>): void {
  rmSync(path.join(project.root, '.pecot/config/projects/.active'))
}

/**
同じリポを含む 2 つ目の設定（second）を足し、.active を外す。対象のリポで選ぶ設定が 1 つに決まらない
*/
export function makeAmbiguous(project: Readonly<ProjectFixture>): void {
  const directory = path.join(project.root, '.pecot/config/projects')
  copyFileSync(path.join(directory, project.configFile), path.join(directory, `${SECOND_CONFIG}.json`))
  removeActive(project)
}
