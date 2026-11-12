/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは skills 配下のみ */
// スキル名の `w-` プレフィックス規約の固定。hooks の短縮形の検知（/w-pr など）は、このプレフィックスに依存する。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { pluginRoot } from './_helpers/paths.js'

const skillsDirectory = path.join(pluginRoot, 'skills')
const SKILL_PREFIX = 'w-'
// 列挙が空振りしたまま全件通るのを防ぐ下限。
const MIN_SKILLS = 10

// skills/ 直下のスキルディレクトリ。テスト資材の tests は除く。
function skillNames(): string[] {
  return readdirSync(skillsDirectory)
    .filter(name => name !== 'tests' && statSync(path.join(skillsDirectory, name)).isDirectory())
    .toSorted(compareStrings)
}

describe('スキル名の規約', () => {
  it('すべてのスキル名が w- で始まる', () => {
    const violations = skillNames().filter(name => !name.startsWith(SKILL_PREFIX))
    expect(violations, `${SKILL_PREFIX} で始まらないスキルがあります。hooks の短縮形検知はこのプレフィックスで pecot コマンドを判別します`).toEqual([])
  })

  it('スキルの列挙は下限を割らない', () => {
    const skills = skillNames()
    expect(skills.length, `スキルが ${String(skills.length)} 件しか列挙できていません。探索先 ${skillsDirectory} を確認してください`).toBeGreaterThanOrEqual(MIN_SKILLS)
  })
})
