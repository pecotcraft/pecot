// 同梱の .drawio（skills 配下と assets 配下）が、実物の文章規則で違反 0 件であることを確かめる。
// 同梱の図が生成前の確認で止まると、利用者はその図を使えないため。

/* eslint-disable security/detect-non-literal-fs-filename -- 同梱ツリーの走査と読み込みのみ */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectTextViolations } from '../../src/domain/_shared/text-check.js'
import { labelTexts } from '../../src/domain/drawio/label-text.js'
import { defaultLintText } from '../../src/infra/text-lint.js'

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
  it('同梱の .drawio を 1 件以上見つける', () => {
    expect(FILES.length).toBeGreaterThan(0)
  })

  it.each(FILES.map(file => [path.relative(PLUGIN_ROOT, file), file]))('%s は違反 0 件', async (_name, file) => {
    const violations = await collectTextViolations(labelTexts(readFileSync(file, 'utf8')), defaultLintText)
    expect(violations).toStrictEqual([])
  })
})
