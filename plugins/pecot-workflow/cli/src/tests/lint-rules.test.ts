// 層の規則と GitHub の I/O の規則が eslint.config.js から消えたら落とすテスト。
// 規則: infra は commands・mcp を import しない（lib の層も同じ）。cli のどのファイルも、GitHub の client と偽の GitHub を import しない。
// 実在するファイルのパスで、中身だけ差し替えた文字列を lintText に渡す。
import path from 'node:path'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

import { explains } from '../../tests/_helpers/explains.js'

const projectDirectory = path.resolve(import.meta.dirname, '../..')
const infraFile = path.join(projectDirectory, 'src', 'infra', 'worktree.ts')
const commandFile = path.join(projectDirectory, 'src', 'commands', 'project.ts')
const testFile = path.join(projectDirectory, 'tests', 'issue-coverage.test.ts')
const scriptFile = path.join(projectDirectory, 'scripts', 'export-interface.ts')

// 型情報付きの ESLint は、最初の lintText がプロジェクト全体の読み込みで重い（単体で約 1.5 秒）。
// CI では他のレーンと並列に動き、その数倍になる。重い処理は beforeAll の 1 回に寄せ、
// 並列実行の負荷を見込んで時間切れを長くとる。各テストは読み込み済みの状態で動く。
const WARM_UP_TIMEOUT_MS = 120_000
const eslint = new ESLint({ cwd: projectDirectory })

beforeAll(async () => {
  await eslint.lintText('export const warmUp = 1\n', { filePath: infraFile })
}, WARM_UP_TIMEOUT_MS)

async function ruleIds(code: string, filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return (result?.messages ?? []).map(message => message.ruleId ?? 'parse-error')
}

describe('infra の依存方向', () => {
  it('infra から commands を import すると、import-x/no-restricted-paths の違反になる', async () => {
    await explains('eslint の層の規則のテストです。infra のファイルから commands のファイルを import したコードを渡した場合は、`import-x/no-restricted-paths` の違反が報告されることを確認します。')
    const ids = await ruleIds('import { TOOLS } from \'../commands/registry.js\'\n\nexport const used = TOOLS\n', infraFile)
    expect(ids).toContain('import-x/no-restricted-paths')
  })

  it('infra から lib の commands-shared を import すると、no-restricted-imports の違反になる', async () => {
    await explains('eslint の層の規則のテストです。infra のファイルから lib の `commands-shared` を import したコードを渡した場合は、`no-restricted-imports` の違反が報告されることを確認します。')
    const ids = await ruleIds('import { createOutput } from \'@pecot/workflow-core/commands-shared/output.js\'\n\nexport const used = createOutput\n', infraFile)
    expect(ids).toContain('no-restricted-imports')
  })

  it('infra から node:fs を import しても、違反にならない', async () => {
    await explains('eslint の層の規則のテストです。infra のファイルから `node:fs` を import したコードを渡した場合は、`no-restricted-imports` の違反が報告されないことを確認します。')
    const ids = await ruleIds('import { readFileSync } from \'node:fs\'\n\nexport const used = readFileSync\n', infraFile)
    expect(ids).not.toContain('no-restricted-imports')
  })
})

const GITHUB_IO_SOURCES = [
  { name: 'lib の infra/github の subpath', source: '@pecot/workflow-core/infra/github/client.js' },
  { name: 'lib の github-client の subpath', source: '@pecot/workflow-core/commands-shared/github-client.js' },
  { name: 'workflow-core の infra/github の相対パス', source: '../../../../libs/workflow-core/src/infra/github/client.js' },
  { name: '偽の GitHub の相対パス', source: '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js' },
]

const LINTED_FILES = [
  { name: 'infra', filePath: infraFile },
  { name: 'commands', filePath: commandFile },
  { name: 'tests', filePath: testFile },
  { name: 'scripts', filePath: scriptFile },
]

describe('GitHub の I/O の import', () => {
  describe.for(LINTED_FILES)('$name のファイル', ({ name, filePath }) => {
    it.for(GITHUB_IO_SOURCES)('$name を import すると、no-restricted-imports の違反になる', async ({ name: sourceName, source }) => {
      await explains(`cli から GitHub の I/O を import させない eslint の規則のテストです。${name} のファイルで ${sourceName} を import した場合に、\`no-restricted-imports\` の違反が報告されることを確認します。`)
      const ids = await ruleIds(`import * as used from '${source}'\n\nexport const value = used\n`, filePath)
      expect(ids).toContain('no-restricted-imports')
    })
  })

  it('lib の infra/github でない infra を import しても、no-restricted-imports の違反にならない', async () => {
    await explains('cli から GitHub の I/O を import させない eslint の規則のテストです。commands のファイルで lib の `infra/git.js` を import した場合は、`no-restricted-imports` の違反が報告されないことを確認します。')
    const ids = await ruleIds('import { runGit } from \'@pecot/workflow-core/infra/git.js\'\n\nexport const used = runGit\n', commandFile)
    expect(ids).not.toContain('no-restricted-imports')
  })
})
