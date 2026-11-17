// workflow install の振る舞い（PW-WORKFLOW-INSTALL-*）を、runCli をプロセス内で呼んで確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { pluginRoot } from '../../src/version.js'
import { runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult } from '../_helpers/command-harness.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

const DESTINATION = '.github/workflows/pecot-review.yml'
const TEMPLATE_FILE = path.join(pluginRoot(), 'cli/templates/workflow/pecot-review.yml')
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
const BUNDLED = readFileSync(TEMPLATE_FILE, 'utf8')
const OLD = BUNDLED.replace(/^# pecot-workflow-template: review \d+/u, '# pecot-workflow-template: review 0')
const USER_LINE = '      - run: pnpm install --frozen-lockfile'
const WITH_USER_LINE = BUNDLED.replace('      # pecot-review:prepare:end', () => `${USER_LINE}\n      # pecot-review:prepare:end`)
const NO_FILES: Readonly<Record<string, string>> = {}

async function install(argv: readonly string[], files = NO_FILES): Promise<CommandResult> {
  return await runCommand({ argv: ['workflow', 'install', 'review', ...argv], files, config: false, github: [] })
}

describe('workflow install', () => {
  it('置き先にファイルが無いとき打つと、雛形を書き出し、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-01')
    const result = await install([])
    expect(result.code).toBe(0)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.stderr).toBe(`created: ${DESTINATION}\n`)
    expect(result.requests).toEqual([])
  })

  it('雛形を書き出すと、次にすることを標準出力に出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-02')
    const result = await install([])
    expect(result.stdout).toBe([
      'next:',
      '  1. install the Claude GitHub App on the repository',
      '  2. set secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_* in Settings > Secrets and variables > Actions',
      '  3. check the settings with: pecot workflow doctor review',
      '',
    ].join('\n'))
  })

  it('--dry-run を付けて打つと、何も書かずに dry-run の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-03')
    const result = await install(['-n'])
    expect(result.code).toBe(0)
    expect(result.read(DESTINATION)).toBeUndefined()
    expect(result.stderr).toBe(`dry-run: would create ${DESTINATION}\n`)
  })

  it('置き先にファイルのあるとき --force を付けずに打つと、何も書かずに終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-04')
    const result = await install([], { [DESTINATION]: OLD })
    expect(result.code).toBe(2)
    expect(result.read(DESTINATION)).toBe(OLD)
    expect(result.stderr).toBe(`error: ${DESTINATION} already exists\n  overwrite it with: pecot workflow install review --force\n`)
  })

  it('--force を付けて打つと、既にあるファイルを雛形で上書きし、updated の行を出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-05')
    const result = await install(['--force'], { [DESTINATION]: OLD })
    expect(result.code).toBe(0)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.stderr).toBe(`updated: ${DESTINATION}\n`)
  })

  it('--force で、利用者の足した行が囲みにあると、上書きの前に消える行を warning で出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-06')
    const result = await install(['--force'], { [DESTINATION]: WITH_USER_LINE })
    expect(result.code).toBe(0)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.stderr).toBe(`warning: these lines between the markers will be removed:\n  ${USER_LINE}\nupdated: ${DESTINATION}\n`)
  })

  it('--check を付けて打ち、版が同梱の雛形と同じなら、何も書かずに終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-07')
    const result = await install(['--check'], { [DESTINATION]: WITH_USER_LINE })
    expect(result.code).toBe(0)
    expect(result.read(DESTINATION)).toBe(WITH_USER_LINE)
    expect(result.stderr).toMatch(/^unchanged: \.github\/workflows\/pecot-review\.yml \(workflow template review \d+\)\n$/u)
  })

  it.for([
    { name: '版が古い', installed: OLD, line: 'workflow template review is outdated', run: 'pecot workflow install review --force' },
    { name: 'ファイルが無い', installed: undefined, line: `${DESTINATION} is missing`, run: 'pecot workflow install review' },
  ])('--check で $name とき、更新のコマンドを出して終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-08')
    const result = await install(['--check'], row.installed === undefined ? NO_FILES : { [DESTINATION]: row.installed })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`error: ${row.line}`)
    expect(result.stderr).toContain(`  update it with: ${row.run}\n`)
    expect(result.read(DESTINATION)).toBe(row.installed)
  })

  it('名前が一覧に無いと、一覧の名前を出して終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-09')
    const result = await runCommand({ argv: ['workflow', 'install', 'deploy'], config: false, github: [] })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: unknown workflow template: deploy\n  available: review\n')
  })

  it.for([{ flag: '--force' }, { flag: '--dry-run' }])('--check と $flag を一緒に渡すと、何も書かずに終了コード 2 で終わる', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-10')
    const result = await install(['--check', row.flag])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: --check cannot be used with --force or --dry-run\n')
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  describe('MCP の結果', () => {
    it('書き出すと、置き先・版・written を返す', async (context) => {
      await verifies(context, 'PW-WORKFLOW-INSTALL-01')
      const result = await runTool({ tool: 'workflow_install', arguments: { name: 'review' }, config: false, github: [] })
      expect(result.isError).toBeFalsy()
      expect(result.structured).toMatchObject({ path: DESTINATION, written: true })
      expect(result.structured).toHaveProperty('version')
    })

    it('check で版が古いと、upToDate を false にして not-ready で返す', async (context) => {
      await verifies(context, 'PW-WORKFLOW-INSTALL-08')
      const result = await runTool({ tool: 'workflow_install', arguments: { name: 'review', check: true }, config: false, files: { [DESTINATION]: OLD }, github: [] })
      expect(result.isError).toBe(true)
      expect(result.structured).toMatchObject({ kind: 'not-ready', path: DESTINATION, installedVersion: 0, written: false, upToDate: false })
    })
  })
})
