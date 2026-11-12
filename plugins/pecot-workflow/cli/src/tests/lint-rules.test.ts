// 層の規則が eslint.config.js から消えたら落とすテスト。
// 規則: domain は infra・commands・mcp を import しない。domain は node:fs・node:child_process を import しない。
// 実在する domain のファイルのパスで、中身だけ差し替えた文字列を lintText に渡す。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const projectDirectory = path.resolve(import.meta.dirname, '../..')
const domainFile = path.join(projectDirectory, 'src', 'domain', 'errors.ts')
const domainTestFile = path.join(projectDirectory, 'src', 'domain', 'tests', 'git-url.test.ts')
const infraFile = path.join(projectDirectory, 'src', 'infra', 'git.ts')

// 型情報付きの ESLint は、最初の lintText がプロジェクト全体の読み込みで重い（単体で約 1.5 秒）。
// CI では他のレーンと並列に動き、その数倍になる。重い処理は beforeAll の 1 回に寄せ、
// 並列実行の負荷を見込んで時間切れを長くとる。各テストは読み込み済みの状態で動く。
const WARM_UP_TIMEOUT_MS = 120_000
const eslint = new ESLint({ cwd: projectDirectory })

beforeAll(async () => {
  await eslint.lintText('export const warmUp = 1\n', { filePath: domainFile })
}, WARM_UP_TIMEOUT_MS)

async function ruleIds(code: string, filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? []).map(message => message.ruleId ?? 'parse-error')
}

describe('domain の依存方向', () => {
  it('domain から infra の import は import-x/no-restricted-paths に当たる', async () => {
    const ids = await ruleIds('import { runGit } from \'../infra/git.js\'\n\nexport const used = runGit\n', domainFile)
    expect(ids).toContain('import-x/no-restricted-paths')
  })

  it('infra から domain の import は違反にならない', async () => {
    const ids = await ruleIds('import { PecotError } from \'../domain/errors.js\'\n\nexport const used = PecotError\n', infraFile)
    expect(ids).not.toContain('import-x/no-restricted-paths')
  })

  it('domain から node:fs の import は no-restricted-imports に当たる', async () => {
    const ids = await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', domainFile)
    expect(ids).toContain('no-restricted-imports')
  })

  it('domain から node:fs/promises と fs の import も当たる', async () => {
    expect(await ruleIds('import { readFile } from \'node:fs/promises\'\n\nexport const used = readFile\n', domainFile)).toContain('no-restricted-imports')
    expect(await ruleIds('import { readFileSync } from \'fs\'\n\nexport const used = readFileSync\n', domainFile)).toContain('no-restricted-imports')
  })

  it.each(['node:os', 'node:net', 'node:http', 'node:https', 'node:process'])('domain から %s の import は no-restricted-imports に当たる', async (name) => {
    const ids = await ruleIds(`import * as used from '${name}'\n\nexport const value = used\n`, domainFile)
    expect(ids).toContain('no-restricted-imports')
  })

  it('domain でグローバルの fetch と process は no-restricted-globals に当たる', async () => {
    const ids = await ruleIds('export const call = fetch\nexport const environment = process.env\n', domainFile)
    expect(ids.filter(id => id === 'no-restricted-globals')).toHaveLength(2)
  })

  it('domain で globalThis.fetch は no-restricted-properties に当たる', async () => {
    const ids = await ruleIds('export const call = globalThis.fetch\n', domainFile)
    expect(ids).toContain('no-restricted-properties')
  })

  it('infra ではグローバルの fetch と process を許す', async () => {
    const ids = await ruleIds('export const call = fetch\nexport const environment = process.env\n', infraFile)
    expect(ids).not.toContain('no-restricted-globals')
  })

  it('domain から node:child_process の import は no-restricted-imports に当たる', async () => {
    const ids = await ruleIds('import { spawnSync } from \'node:child_process\'\n\nexport const used = spawnSync\n', domainFile)
    expect(ids).toContain('no-restricted-imports')
  })

  it('domain から node:path の import は許す', async () => {
    const ids = await ruleIds('import path from \'node:path\'\n\nexport const used = path.sep\n', domainFile)
    expect(ids).not.toContain('no-restricted-imports')
  })

  it('infra から node:fs の import は許す', async () => {
    const ids = await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', infraFile)
    expect(ids).not.toContain('no-restricted-imports')
  })

  it('domain のテストからの node:fs の import は許す', async () => {
    const ids = await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', domainTestFile)
    expect(ids).not.toContain('no-restricted-imports')
  })
})
