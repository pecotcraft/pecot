// 同梱の .drawio（skills 配下と assets 配下）が、実物の文章規則で違反 0 件であることを確かめる。
// 同梱の図が生成前の確認で止まると、利用者はその図を使えないため。

/* eslint-disable security/detect-non-literal-fs-filename -- 同梱ツリーの走査と読み込みのみ */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectTextViolations } from '../../src/domain/_shared/text-check.js'
import { labelTexts } from '../../src/domain/drawio/label-text.js'
import { defaultLintText } from '../../src/infra/text-lint.js'
import { explains } from '../_helpers/explains.js'

// tests/unit → cli/ → plugins/pecot-visual
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const BUNDLED_ROOTS: readonly string[] = ['skills', 'assets']

function drawioFilesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.drawio'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => !file.split(path.sep).includes('node_modules'))
    .toSorted((left, right) => left.localeCompare(right))
}

const FILES = BUNDLED_ROOTS.flatMap(root => drawioFilesUnder(path.join(PLUGIN_ROOT, root)))

describe('同梱の .drawio の文面', () => {
  it('同梱の .drawio が 1 件以上存在する', async () => {
    await explains('同梱の `.drawio` の検出のテストです。`skills` と `assets` の下を走査した場合に、以降の文面のチェックが 0 件で通らないよう、`.drawio` が 1 件以上見つかることを確認します。')
    expect(FILES.length).toBeGreaterThan(0)
  })

  it.each(FILES.map(file => [path.relative(PLUGIN_ROOT, file), file]))('同梱の .drawio（%s）は、文面の違反が 0 件になる', async (_name, file) => {
    await explains('同梱の `.drawio` の文面のテストです。図のラベルの文章に、実際の文章の規則を適用した場合に、違反が 0 件であることを確認します。')
    const violations = await collectTextViolations(labelTexts(readFileSync(file, 'utf8')), defaultLintText)
    expect(violations).toStrictEqual([])
  })
})
