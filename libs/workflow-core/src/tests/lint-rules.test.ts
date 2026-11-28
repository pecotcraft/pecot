// 層の規則が eslint.config.js から消えたら落とすテスト。
// 規則: domain は infra・commands-shared を import しない。infra は commands-shared を import しない。domain は node:fs・node:child_process を import しない。
// 実在する domain のファイルのパスで、中身だけ差し替えた文字列を lintText に渡す。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { step, stepSync } from '../../tests/_helpers/step.js'
import { explains } from '../../tests/_helpers/explains.js'

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
  it('domain から infra を import すると、import-x/no-restricted-paths の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルから `infra` を import した場合に、`import-x/no-restricted-paths` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { runGit } from \'../infra/git.js\'\n\nexport const used = runGit\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('import-x/no-restricted-paths')
    })
  })

  it('infra から commands-shared を import すると、import-x/no-restricted-paths の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`infra` のファイルから `commands-shared` を import した場合に、`import-x/no-restricted-paths` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { createOutput } from \'../commands-shared/output.js\'\n\nexport const used = createOutput\n', infraFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('import-x/no-restricted-paths')
    })
  })

  it('自分の package 名で import すると、no-restricted-imports の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。自分の package 名（`@pecot/workflow-core`）で import した場合に、`no-restricted-imports` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { runGit } from \'@pecot/workflow-core/infra/git.js\'\n\nexport const used = runGit\n', infraFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('no-restricted-imports')
    })
  })

  it('infra から domain を import しても、違反にならない', async () => {
    await explains('ESLint の層の規則のテストです。`infra` のファイルから `domain` を import した場合に、`import-x/no-restricted-paths` の違反として検出されないことを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { PecotError } from \'../domain/errors.js\'\n\nexport const used = PecotError\n', infraFile))
    stepSync('結果を確認する', () => {
      expect(ids).not.toContain('import-x/no-restricted-paths')
    })
  })

  it('domain から node:fs を import すると、no-restricted-imports の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルから `node:fs` を import した場合に、`no-restricted-imports` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('no-restricted-imports')
    })
  })

  it('domain から node:fs/promises と fs を import しても、no-restricted-imports の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルから `node:fs/promises` と `fs` を import した場合も、どちらも `no-restricted-imports` の違反として検出されることを確認します。')
    await step('検出した規則を確認する', async () => {
      expect(await ruleIds('import { readFile } from \'node:fs/promises\'\n\nexport const used = readFile\n', domainFile)).toContain('no-restricted-imports')
      expect(await ruleIds('import { readFileSync } from \'fs\'\n\nexport const used = readFileSync\n', domainFile)).toContain('no-restricted-imports')
    })
  })

  it.each(['node:os', 'node:net', 'node:http', 'node:https', 'node:process'])('domain から %s を import すると、no-restricted-imports の違反になる', async (name) => {
    await explains(`ESLint の層の規則のテストです。\`domain\` のファイルから \`${name}\` を import した場合に、\`no-restricted-imports\` の違反として検出されることを確認します。`)
    const ids = await step('lint の規則を打つ', async () => await ruleIds(`import * as used from '${name}'\n\nexport const value = used\n`, domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('no-restricted-imports')
    })
  })

  it('domain でグローバルの fetch と process を参照すると、no-restricted-globals の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルでグローバルの `fetch` と `process` を参照した場合に、`no-restricted-globals` の違反が 2 件検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('export const call = fetch\nexport const environment = process.env\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids.filter(id => id === 'no-restricted-globals')).toHaveLength(2)
    })
  })

  it('domain で globalThis.fetch を参照すると、no-restricted-properties の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルで `globalThis.fetch` を参照した場合に、`no-restricted-properties` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('export const call = globalThis.fetch\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('no-restricted-properties')
    })
  })

  it('infra でグローバルの fetch と process を参照しても、違反にならない', async () => {
    await explains('ESLint の層の規則のテストです。`infra` のファイルでグローバルの `fetch` と `process` を参照した場合に、`no-restricted-globals` の違反として検出されないことを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('export const call = fetch\nexport const environment = process.env\n', infraFile))
    stepSync('結果を確認する', () => {
      expect(ids).not.toContain('no-restricted-globals')
    })
  })

  it('domain から node:child_process を import すると、no-restricted-imports の違反になる', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルから `node:child_process` を import した場合に、`no-restricted-imports` の違反として検出されることを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { spawnSync } from \'node:child_process\'\n\nexport const used = spawnSync\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).toContain('no-restricted-imports')
    })
  })

  it('domain から node:path を import しても、違反にならない', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のファイルから `node:path` を import した場合に、`no-restricted-imports` の違反として検出されないことを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import path from \'node:path\'\n\nexport const used = path.sep\n', domainFile))
    stepSync('結果を確認する', () => {
      expect(ids).not.toContain('no-restricted-imports')
    })
  })

  it('infra から node:fs を import しても、違反にならない', async () => {
    await explains('ESLint の層の規則のテストです。`infra` のファイルから `node:fs` を import した場合に、`no-restricted-imports` の違反として検出されないことを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', infraFile))
    stepSync('結果を確認する', () => {
      expect(ids).not.toContain('no-restricted-imports')
    })
  })

  it('domain のテストから node:fs を import しても、違反にならない', async () => {
    await explains('ESLint の層の規則のテストです。`domain` のテストファイルから `node:fs` を import した場合に、`no-restricted-imports` の違反として検出されないことを確認します。')
    const ids = await step('lint の規則を打つ', async () => await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', domainTestFile))
    stepSync('結果を確認する', () => {
      expect(ids).not.toContain('no-restricted-imports')
    })
  })
})
