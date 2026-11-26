// workflow install の振る舞い（PW-WORKFLOW-INSTALL-*）を、MCP のツールをプロセス内で呼んで確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { pluginRoot } from '../../src/version.js'
import { runCommand, runTool } from '../_helpers/command-harness.js'
import type { ToolResult } from '../_helpers/command-harness.js'
import { verifies } from '../_helpers/verifies.js'
import { explains } from '../_helpers/explains.js'

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

const AUTO_DESTINATION = '.github/workflows/pecot-auto.yml'

// 雛形が無くても、ほかのケースは流れるように、使うケースの中で読む
function bundledAuto(): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
  return readFileSync(path.join(pluginRoot(), 'cli/templates/workflow/pecot-auto.yml'), 'utf8')
}

function versionOfAuto(text: string): number {
  return Number(/^# pecot-workflow-template: auto (\d+)/u.exec(text)?.[1])
}

// このリポの CI のワークフローの名前
function ciWorkflowName(): string {
  const ci = readFileSync(path.join(import.meta.dirname, '../../../../../.github/workflows/ci.yml'), 'utf8')
  return /^name:[ \t]*(\S+)[ \t]*$/mu.exec(ci)?.[1] ?? ''
}

function stringScalars(node: unknown): readonly string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(item => stringScalars(item))
  if (typeof node === 'object' && node !== null) return Object.entries(node).flatMap(([key, value]) => [key, ...stringScalars(value)])
  return []
}

async function install(argumentsOfTool: Readonly<Record<string, unknown>>, files = NO_FILES): Promise<ToolResult> {
  return await runTool({ tool: 'workflow_install', arguments: { name: 'review', ...argumentsOfTool }, files, config: false, github: [] })
}

describe('workflow install', () => {
  it('置き先にファイルが存在しないとき呼ぶと、雛形を書き出し、written を true にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-01')
    await explains('ワークフローの雛形の書き出し（`workflow_install`）のテストです。置き先にファイルが存在しない場合に、雛形を書き出して `written` が `true` になり、GitHub へ要求を送らないことを確認します。')
    const result = await install({})
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ written: true })
    expect(result.requests).toEqual([])
  })

  it('雛形を書き出すと、置き先を path に、同梱の雛形の版を version に入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-02')
    await explains('雛形を書き出した場合の、結果の項目のテストです。置き先が `path` に、同梱の雛形の版が `version` に格納されることを確認します。')
    const result = await install({})
    expect(result.structured).toMatchObject({ path: DESTINATION, version: BUNDLED_VERSION })
  })

  it('CLI で --dry-run を付けると、何も書かずに、書く予定を dry-run の行に出して 0 で終わる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-03')
    await explains('CLI で `--dry-run` を指定した場合のテストです。ファイルを書き出さず、書き出す予定を `dry-run:` の行に出力して、終了コード 0 で終了することを確認します。')
    const result = await runCommand({ argv: ['workflow', 'install', 'review', '--dry-run'], config: false, github: [] })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`dry-run: would create ${DESTINATION}\n`)
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('置き先にファイルのあるとき force を付けずに呼ぶと、何も書かずに already-exists の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-04')
    await explains('置き先にファイルが存在する状態で、`force` を指定せずに呼び出した場合のテストです。ファイルを書き換えず、`already-exists` の失敗が返ることを確認します。')
    const result = await install({}, { [DESTINATION]: OLD })
    expect(result.isError).toBe(true)
    expect(result.read(DESTINATION)).toBe(OLD)
    expect(result.structured).toMatchObject({ kind: 'already-exists' })
    expect(result.structured['detail']).toContain(`${DESTINATION} already exists`)
  })

  it('force を付けて呼ぶと、既にあるファイルを雛形で上書きし、written を true にする', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-05')
    await explains('`force` を指定して呼び出した場合のテストです。既存のファイルが雛形で上書きされ、`written` が `true` になることを確認します。')
    const result = await install({ force: true }, { [DESTINATION]: OLD })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ written: true })
  })

  it('force で、利用者の追加した行が印の間にあると、削除される行を removedLines と warnings に含める', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-06')
    await explains('`force` を指定し、マーカーの間に利用者が追加した行を含む場合のテストです。削除される行が `removedLines` と `warnings` に含まれることを確認します。')
    const result = await install({ force: true }, { [DESTINATION]: WITH_USER_LINE })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.structured).toMatchObject({ removedLines: [USER_LINE], warnings: [`these lines between the markers will be removed:\n  ${USER_LINE}`] })
  })

  it('check を付けて呼び、版が同梱の雛形と同じなら、何も書かずに upToDate を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-07')
    await explains('`check` を指定して呼び出し、版が同梱の雛形と同じ場合のテストです。ファイルを書き換えず、`upToDate` が `true` になって成功の結果が返ることを確認します。')
    const result = await install({ check: true }, { [DESTINATION]: WITH_USER_LINE })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(WITH_USER_LINE)
    expect(result.structured).toMatchObject({ written: false, upToDate: true })
  })

  it.for([
    { name: '版が古い', installed: OLD, line: 'workflow template review is outdated', call: 'workflow_install with name: "review", force: true' },
    { name: 'ファイルが存在しない', installed: undefined, line: `${DESTINATION} is missing`, call: 'workflow_install with name: "review"' },
  ])('check で $name とき、更新の呼び方を detail に含めて not-ready の失敗を返す', async (row, context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-08')
    await explains('`check` を指定して呼び出し、版が古い場合と、ファイルが存在しない場合のテストです。ファイルを書き換えず、更新の呼び出し方を `detail` に含めた `not-ready` の失敗が返ることを確認します。')
    const result = await install({ check: true }, row.installed === undefined ? NO_FILES : { [DESTINATION]: row.installed })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'not-ready', path: DESTINATION, written: false, upToDate: false })
    expect(result.structured['detail']).toContain(row.line)
    expect(result.structured['detail']).toContain(row.call)
    expect(result.read(DESTINATION)).toBe(row.installed)
  })

  it('名前が雛形の一覧に存在しないと、一覧の名前を detail に含めて invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-09')
    await explains('存在しない雛形の名前（`deploy`）を指定した場合のテストです。`invalid-input` の失敗が返り、`detail` に不明な雛形であることと、指定できる名前の一覧が含まれることを確認します。')
    const result = await install({ name: 'deploy' })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input' })
    expect(result.structured['detail']).toContain('unknown workflow template: deploy')
    expect(result.structured['detail']).toContain('available: review, handoff, auto')
  })

  it('name に auto を渡すと、自動処理の雛形を .github/workflows/pecot-auto.yml に書き出し、雛形の版を version に入れる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-01')
    await explains('`name` に `auto` を指定した場合のテストです。自動処理の雛形が `.github/workflows/pecot-auto.yml` に書き出され、雛形の版が `version` に格納されることを確認します。')
    await verifies(context, 'PW-WORKFLOW-INSTALL-02')
    const bundled = bundledAuto()
    const result = await install({ name: 'auto' })
    expect(result.isError).toBe(false)
    expect(result.read(AUTO_DESTINATION)).toBe(bundled)
    expect(result.structured).toMatchObject({ written: true, path: AUTO_DESTINATION, version: versionOfAuto(bundled) })
  })

  it('auto で check を付けて呼び、版が同梱の雛形と同じなら、upToDate を true にして成功を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-07')
    await explains('`name` に `auto` を指定し、`check` を付けて、版が同梱の雛形と同じ場合のテストです。`upToDate` が `true` になり、成功の結果が返ることを確認します。')
    const bundled = bundledAuto()
    const result = await install({ name: 'auto', check: true }, { [AUTO_DESTINATION]: bundled })
    expect(result.isError).toBe(false)
    expect(result.structured).toMatchObject({ written: false, upToDate: true })
  })

  it('auto で check を付けて呼び、版が古いと、force の呼び方を detail に入れて not-ready の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-08')
    await explains('`name` に `auto` を指定し、`check` を付けて、版が古い場合のテストです。`force` を付けた呼び出し方を `detail` に含めた、`not-ready` の失敗が返ることを確認します。')
    const old = bundledAuto().replace(/^# pecot-workflow-template: auto \d+/u, '# pecot-workflow-template: auto 0')
    const result = await install({ name: 'auto', check: true }, { [AUTO_DESTINATION]: old })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'not-ready', path: AUTO_DESTINATION, written: false, upToDate: false })
    expect(result.structured['detail']).toContain('workflow template auto is outdated')
    expect(result.structured['detail']).toContain('workflow_install with name: "auto", force: true')
  })

  it('auto で force を付けて呼び、利用者の追加した行が囲みの中にあると、削除される行を removedLines に含める', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-06')
    await explains('`name` に `auto` を指定し、`force` を付けて、マーカーの間に利用者が追加した行を含む場合のテストです。削除される行が `removedLines` に含まれ、ファイルが雛形に置き換わることを確認します。')
    const bundled = bundledAuto()
    const end = /^[ \t]*# pecot-auto:[\w-]+:end$/mu.exec(bundled)?.[0]
    if (end === undefined) throw new Error('the auto template has no block marker')
    const indent = /^[ \t]*/u.exec(end)?.[0] ?? ''
    const userLine = `${indent}- run: pnpm install --frozen-lockfile`
    const result = await install({ name: 'auto', force: true }, { [AUTO_DESTINATION]: bundled.replace(end, () => `${userLine}\n${end}`) })
    expect(result.isError).toBe(false)
    expect(result.read(AUTO_DESTINATION)).toBe(bundled)
    expect(result.structured).toMatchObject({ written: true, removedLines: [userLine] })
  })

  it('auto を書き出すと、このリポの設定の名前と CI のワークフローの名前が、書き出したファイルに残らない', async () => {
    await explains('`name` に `auto` を指定して書き出したファイルの中身のテストです。このリポジトリの設定の名前と CI のワークフローの名前が、書き出したファイルに含まれないことを確認します。')
    const result = await install({ name: 'auto' })
    const written = result.read(AUTO_DESTINATION) ?? ''
    expect(written).not.toBe('')
    // プラグインの配布元の marketplace だけは、このリポを指す
    expect(written.replaceAll('https://github.com/pecotcraft/pecot.git', '')).not.toMatch(/pecotcraft/iu)
    expect(written).not.toContain('github.com_pecotcraft')
    const ciName = ciWorkflowName()
    expect(ciName).not.toBe('')
    expect(stringScalars(parse(written))).not.toContain(ciName)
  })

  it('CLI で auto を書き出すと、次にすることに App の変数と secret の設定を入れ、Claude の App の手順を入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-14')
    await explains('CLI で `auto` の雛形を書き出した場合の、次の手順の表示のテストです。App の変数と secret の設定が含まれ、Claude GitHub App の手順が含まれないことを確認します。')
    const result = await runCommand({ argv: ['workflow', 'install', 'auto'], config: false, github: [] })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe([
      'next:',
      '  1. set variable PECOT_AGENT_APP_CLIENT_ID in Settings > Secrets and variables > Actions',
      '  2. set secret PECOT_AGENT_APP_PRIVATE_KEY in Settings > Secrets and variables > Actions',
      '  3. set secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_* in Settings > Secrets and variables > Actions',
      '  4. check the settings with: pecot workflow doctor auto',
      '',
    ].join('\n'))
  })

  it('name に handoff を渡すと、引き継ぎの雛形を .github/workflows/pecot-handoff.yml に書き出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-01')
    await explains('`name` に `handoff` を指定した場合のテストです。引き継ぎの雛形が `.github/workflows/pecot-handoff.yml` に書き出され、結果に版が含まれることを確認します。')
    const handoffFile = path.join(pluginRoot(), 'cli/templates/workflow/pecot-handoff.yml')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の雛形のパス
    const bundledHandoff = readFileSync(handoffFile, 'utf8')
    const result = await install({ name: 'handoff' })
    expect(result.isError).toBe(false)
    expect(result.read('.github/workflows/pecot-handoff.yml')).toBe(bundledHandoff)
    expect(result.structured).toMatchObject({ written: true, path: '.github/workflows/pecot-handoff.yml', version: 2 })
  })

  it('CLI で handoff を書き出すと、次にすることに Claude の App の手順を入れない', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-13')
    await explains('CLI で `handoff` の雛形を書き出した場合の、次の手順の表示のテストです。Claude GitHub App の手順が含まれないことを確認します。')
    const result = await runCommand({ argv: ['workflow', 'install', 'handoff'], config: false, github: [] })
    expect(result.stdout).toBe([
      'next:',
      '  1. set secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_* in Settings > Secrets and variables > Actions',
      '  2. check the settings with: pecot workflow doctor handoff',
      '',
    ].join('\n'))
  })

  it('check と force を一緒に渡すと、何も書かずに invalid-input の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-10')
    await explains('`check` と `force` を同時に指定した場合のテストです。ファイルを書き出さず、`invalid-input` の失敗が返ることを確認します。')
    const result = await install({ check: true, force: true })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'invalid-input', detail: 'check cannot be used with force' })
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('CLI で --check と --dry-run を一緒に付けると、何も書かずに使い方の誤りで止まる', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-10')
    await explains('CLI で `--check` と `--dry-run` を同時に指定した場合のテストです。ファイルを書き出さず、使い方の誤りを示す終了コード 2 で終了することを確認します。')
    const result = await runCommand({ argv: ['workflow', 'install', 'review', '--check', '--dry-run'], config: false, github: [] })
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('error: --check cannot be used with --force or --dry-run\n')
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('リポのサブディレクトリを directory に渡すと、リポのルートからの置き先に書き出す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-11')
    await explains('リポジトリのサブディレクトリを `directory` に指定した場合のテストです。リポジトリのルートを基準にした置き先へ書き出し、サブディレクトリの下には書き出さないことを確認します。')
    const result = await install({ directory: 'sub' }, { 'sub/.keep': '' })
    expect(result.isError).toBe(false)
    expect(result.read(DESTINATION)).toBe(BUNDLED)
    expect(result.read(`sub/${DESTINATION}`)).toBeUndefined()
  })

  it('directory が Git リポジトリの外なら、何も書かずに git-unresolved の失敗を返す', async (context) => {
    await verifies(context, 'PW-WORKFLOW-INSTALL-12')
    await explains('`directory` が Git リポジトリの外の場合のテストです。ファイルを書き出さず、`git-unresolved` の失敗が返ることを確認します。')
    const result = await runTool({ tool: 'workflow_install', arguments: { name: 'review' }, remote: false, config: false, github: [] })
    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({ kind: 'git-unresolved' })
    expect(result.read(DESTINATION)).toBeUndefined()
  })

  it('CLI で雛形を書き出すと、次にすることを標準出力に出す', async () => {
    await explains('CLI で雛形を書き出した場合の、次の手順の表示のテストです。Claude GitHub App のインストール、認証の設定、設定の確認の 3 つの手順が標準出力に表示されることを確認します。')
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
