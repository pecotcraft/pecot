// workflow install の振る舞い（PW-WORKFLOW-INSTALL-*）を、MCP のツールをプロセス内で呼んで確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { pluginRoot } from '../../src/version.js'
import { runCommand, runTool } from '../_helpers/command-harness.js'
import type { ToolResult } from '../_helpers/command-harness.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const DESTINATION = '.github/workflows/pecot-review.yml'
const TEMPLATE_FILE = path.join(pluginRoot(), 'cli/templates/workflow/pecot-review.yml')
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
const BUNDLED = readFileSync(TEMPLATE_FILE, 'utf8')
const BUNDLED_VERSION = Number(/^# pecot-workflow-template: review (\d+)/mu.exec(BUNDLED)?.[1])
const OLD = BUNDLED.replace(/^# pecot-workflow-template: review \d+/u, '# pecot-workflow-template: review 0')
const USER_LINE = '      - run: pnpm install --frozen-lockfile'
const WITH_USER_LINE = BUNDLED.replace('      # pecot-review:prepare:end', () => `${USER_LINE}\n      # pecot-review:prepare:end`)
const NO_FILES: Readonly<Record<string, string>> = {}

async function install(argumentsOfTool: Readonly<Record<string, unknown>>, files = NO_FILES): Promise<ToolResult> {
  return await runTool({ tool: 'workflow_install', arguments: { name: 'review', ...argumentsOfTool }, files, config: false, github: [] })
}

describe('workflow install', () => {
  it('置き先にファイルが無いとき呼ぶと、雛形を書き出し、written を true にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-01')
    const result = await install({})
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ written: true })
    expect(result.requests).toEqual([])
  })

  it('雛形を書き出すと、置き先を path に、同梱の雛形の版を version に入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-02')
    const result = await install({})
    expect(result.structured).toMatchObject({ path: DESTINATION, version: BUNDLED_VERSION })
  })

  it('dry_run を付けて呼ぶと、何も書かずに、written を false、dryRun を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-03')
    const result = await install({ dry_run: true })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBeUndefined()
    expect(result.structured).toMatchObject({ written: false, dryRun: true })
  })

  it('置き先にファイルのあるとき force を付けずに呼ぶと、何も書かずに already-exists の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-04')
    const result = await install({}, { [DESTINATION]: OLD })
    expect(result.isError).toBe(true)
    expect(result.read(DESTINATION)).toBe(OLD)
    expect(result.structured).toMatchObject({ kind: 'already-exists' })
    expect(result.structured['detail']).toContain(`${DESTINATION} already exists`)
  })

  it('force を付けて呼ぶと、既にあるファイルを雛形で上書きし、written を true にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-05')
    const result = await install({ force: true }, { [DESTINATION]: OLD })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ written: true })
  })

  it('force で、利用者の足した行が印の間にあると、消える行を removedLines と warnings に入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-06')
    const result = await install({ force: true }, { [DESTINATION]: WITH_USER_LINE })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ removedLines: [USER_LINE], warnings: [`these lines between the markers will be removed:\n  ${USER_LINE}`] })
  })

  it('check を付けて呼び、版が同梱の雛形と同じなら、何も書かずに upToDate を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-07')
    const result = await install({ check: true }, { [DESTINATION]: WITH_USER_LINE })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(WITH_USER_LINE)
    expect(result.structured).toMatchObject({ written: false, upToDate: true })
  })

  it.for([
    { name: '版が古い', installed: OLD, line: 'workflow template review is outdated', call: 'workflow_install with name: "review", force: true' },
    { name: 'ファイルが無い', installed: undefined, line: `${DESTINATION} is missing`, call: 'workflow_install with name: "review"' },
  ])('check で $name とき、更新の呼び方を detail に入れて not-ready の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-08')
    const result = await install({ check: true }, row.installed === undefined ? NO_FILES : { [DESTINATION]: row.installed })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'not-ready', path: DESTINATION, written: false, upToDate: false })
    expect(result.structured['detail']).toContain(row.line)
    expect(result.structured['detail']).toContain(row.call)
    expect(result.read(DESTINATION)).toBe(row.installed)
  })

  it('名前が雛形の一覧に無いと、一覧の名前を detail に入れて invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-09')
    const result = await install({ name: 'deploy' })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input' })
    expect(result.structured['detail']).toContain('unknown workflow template: deploy')
    expect(result.structured['detail']).toContain('available: review')
  })

  it.for([{ flag: 'force' }, { flag: 'dry_run' }])('check と $flag を一緒に渡すと、何も書かずに invalid-input の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-10')
    const result = await install({ check: true, [row.flag]: true })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input' })
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('リポのサブディレクトリを directory に渡すと、リポのルートからの置き先に書き出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-11')
    const result = await install({ directory: 'sub' }, { 'sub/.keep': '' })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.read(`sub/${DESTINATION}`)).toBeUndefined()
  })

  it('directory が Git リポジトリの外なら、何も書かずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-12')
    const result = await runTool({ tool: 'workflow_install', arguments: { name: 'review' }, remote: false, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('CLI で雛形を書き出すと、次にすることを標準出力に出す', async () => {
    const result = await runCommand({ argv: ['workflow', 'install', 'review'], config: false, github: [] })
    expect(result.stdout).toBe([
      'next:',
      '  1. install the Claude GitHub App on the repository',
      '  2. set secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_* in Settings > Secrets and variables > Actions',
      '  3. check the settings with: pecot workflow doctor review',
      '',
    ].join('\n'))
  })
})
