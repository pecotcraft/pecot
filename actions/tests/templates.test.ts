/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはこのリポの雛形と package.json だけ */
// 利用者のリポに置く雛形が、pecot の action を今の版のタグで指し、プラグインの写しと同じことを確かめる。
// 中身の形は、プラグインの写しを読む plugins/pecot-workflow/cli/tests/*-workflow-template.test.ts が確かめる。
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

import { COPY, SOURCE, staleCopies } from '../scripts/sync-plugin-templates.js'
import { makeTemporaryDirectory } from '../../libs/workflow-core/tests/_helpers/temporary.js'

const ACTIONS_ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGE: unknown = JSON.parse(readFileSync(path.join(ACTIONS_ROOT, 'package.json'), 'utf8'))
const VERSION = typeof PACKAGE === 'object' && PACKAGE !== null ? String(Reflect.get(PACKAGE, 'version')) : ''
const TEMPLATES = readdirSync(SOURCE).filter(name => name.endsWith('.yml')).toSorted((a, b) => a.localeCompare(b))
const PECOT_ACTION = /uses: pecotcraft\/pecot\/actions\/([a-z-]+)@(\S+)/gu

function read(name: string): string {
  return readFileSync(path.join(SOURCE, name), 'utf8')
}

describe('actions/templates', () => {
  it('雛形は 5 つで、どれも 1 行目に版の目印を持つ', async () => {
    await explains('利用者のリポに置くワークフローの雛形（`actions/templates/`）のテストです。雛形が 5 つあり、どれも 1 行目に `pecot-workflow-template:` の版の目印を持つことを確認します。')
    expect(TEMPLATES).toEqual(['pecot-auto.yml', 'pecot-board-sync.yml', 'pecot-github-ops.yml', 'pecot-handoff.yml', 'pecot-review.yml'])
    for (const name of TEMPLATES) expect(read(name).split('\n', 1)[0]).toMatch(/^# pecot-workflow-template: [a-z-]+ \d+$/u)
  })

  it.for(TEMPLATES.filter(name => name !== 'pecot-handoff.yml'))('%s は pecot の action を actions/package.json の版のタグで指す', async (name) => {
    await explains(`ワークフローの雛形 \`${name}\` のテストです。pecot の action を 1 つ以上呼び、どれも存在する action を \`actions/package.json\` の版のタグで指していることを確認します。`)
    const references = Array.from(read(name).matchAll(PECOT_ACTION), ([, action = '', tag]) => ({ action, tag }))
    expect(references.length).toBeGreaterThan(0)
    for (const { action, tag } of references) {
      expect(tag).toBe(`pecot-actions/v${VERSION}`)
      expect(readdirSync(ACTIONS_ROOT)).toContain(action)
    }
  })

  it.for(TEMPLATES)('%s は npx で @pecot/workflow-mcp を取らない', async (name) => {
    await explains(`ワークフローの雛形 \`${name}\` のテストです。npx で取得する \`@pecot/workflow-mcp\` を含まないことを確認します。`)
    expect(read(name)).not.toContain('@pecot/workflow-mcp')
  })

  it.for(TEMPLATES)('%s は、なくなった pecot の CLI のコマンドを案内しない', async (name) => {
    await explains(`ワークフローの雛形 \`${name}\` のテストです。\`pecot workflow install\` のような CLI のコマンドを含まないことを確認します。`)
    expect(read(name)).not.toMatch(/`pecot [a-z]/u)
  })

  it('プラグインの写しが actions/templates と同じ', async () => {
    await explains('pecot-workflow の `cli/templates/workflow/` に置く雛形の写しのテストです。どの写しも `actions/templates/` の雛形と一致することを確認します。')
    expect(staleCopies()).toEqual([])
  })

  it('写しが違うファイルと、写しにだけあるファイルを、違うものとして返す', async () => {
    await explains('雛形の写しの差分を求める `staleCopies` のテストです。写しに存在しないファイルと、写しにだけ存在するファイルを、どちらも差分として返すことを確認します。')
    const root = makeTemporaryDirectory('pecot-templates-')
    const source = path.join(root, 'source')
    const copy = path.join(root, 'copy')
    mkdirSync(source)
    mkdirSync(copy)
    writeFileSync(path.join(source, 'a.yml'), 'a: 1\n')
    writeFileSync(path.join(source, 'b.yml'), 'b: 1\n')
    copyFileSync(path.join(source, 'a.yml'), path.join(copy, 'a.yml'))
    writeFileSync(path.join(copy, 'c.yml'), 'c: 1\n')
    expect(staleCopies(source, copy)).toEqual(['b.yml', 'c.yml'])
    expect(COPY).toContain(path.join('plugins', 'pecot-workflow', 'cli', 'templates', 'workflow'))
  })
})
