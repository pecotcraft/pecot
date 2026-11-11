import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { checkLinks, scanBehaviorIds } from '../src/domain/links.js'
import { linkRepository } from '../src/links-repository.js'
import { materialize } from './helpers/repository.js'

async function call(...argv: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(argv, {
    stdout: (text) => {
      stdout.push(text)
    },
    stderr: (text) => {
      stderr.push(text)
    },
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

const TOOLS_FILE = 'plugins/pecot-tools/cli/tests/a.txt'
const WORKFLOW_FILE = 'plugins/pecot-workflow/cli/tests/b.txt'

describe('scanBehaviorIds', () => {
  it('行ごとに ID と行番号を返し、コメントの中も数える', () => {
    const found = scanBehaviorIds({ path: 'a.test.ts', text: `verifies(ctx, 'PT-AWS-S3-LS-01')\n// PW-ISSUE-CREATE-02 と PV-DRAWIO-01\n` })
    expect(found).toEqual([
      { id: 'PT-AWS-S3-LS-01', line: 1 },
      { id: 'PW-ISSUE-CREATE-02', line: 2 },
      { id: 'PV-DRAWIO-01', line: 2 },
    ])
  })

  it('境界の外の ID（桁が多い・前に文字が付く）を拾わない', () => {
    const text = 'PT-X-011 xPW-A-01 a_PW-A-01 -PW-A-01 PW-A-01x PW-A-01_ PW-A-01-\n'
    expect(scanBehaviorIds({ path: 'a.test.ts', text })).toEqual([])
  })

  it('記号や空白に挟まれた ID は拾う', () => {
    expect(scanBehaviorIds({ path: 'a.test.ts', text: '("PW-A-01"),[PW-B-02]' }).map(item => item.id)).toEqual(['PW-A-01', 'PW-B-02'])
  })
})

describe('checkLinks', () => {
  it('coverage が off のとき、テストの無い項目を出さない', () => {
    expect(checkLinks([{ name: 'pecot-tools', coverage: 'off', ids: ['PT-A-01'], tests: [] }])).toEqual([])
  })

  it('ファイル・行・ID の順に並べ、続けてテストの無い項目を ID の順に並べる', () => {
    const lines = checkLinks([{
      name: 'pecot-tools',
      coverage: 'on',
      ids: ['PT-B-01', 'PT-A-01', 'PT-C-01'],
      tests: [
        { path: 'b.test.ts', text: 'PT-Z-01\nPT-C-01\n' },
        { path: 'a.test.ts', text: 'PT-Y-01 PT-X-01\n\nPT-W-01' },
      ],
    }])
    expect(lines).toEqual([
      'error: a.test.ts:1: PT-X-01 is not defined',
      'error: a.test.ts:1: PT-Y-01 is not defined',
      'error: a.test.ts:3: PT-W-01 is not defined',
      'error: b.test.ts:1: PT-Z-01 is not defined',
      'error: PT-A-01 has no test',
      'error: PT-B-01 has no test',
    ])
  })
})

describe('linkRepository', () => {
  it('定義書に無い ID をファイルと行つきで出し、別のプラグインの ID も止める', async () => {
    const lines = await linkRepository(await materialize('links-coverage-off'))
    expect(lines).toEqual([
      `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined`,
      `error: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined`,
    ])
  })

  it('coverage が on のとき、どのテストにも無い項目を出す', async () => {
    const lines = await linkRepository(await materialize('links'))
    expect(lines).toEqual([
      `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined`,
      `error: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined`,
      'error: PW-COMMON-01 has no test',
      'error: PW-ISSUE-CREATE-02 has no test',
      'error: PW-ISSUE-QUICK-01 has no test',
    ])
  })

  it('git が追跡しないファイルは読まない', async () => {
    const root = await materialize('links-coverage-off')
    await writeFile(path.join(root, 'plugins/pecot-tools/cli/tests/untracked.txt'), 'PT-UNTRACKED-01\n')
    const lines = await linkRepository(root)
    expect(lines.some(line => line.includes('PT-UNTRACKED-01'))).toBe(false)
  })

  it('targets.json の形が崩れていると、その行を返す', async () => {
    const lines = await linkRepository(await materialize('targets-invalid'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => line.startsWith('error: libs/interface-spec/targets.json'))).toBe(true)
  })

  it('authored.yaml が読めないプラグインは、ID が空として扱う', async () => {
    const lines = await linkRepository(await materialize('interface-missing'))
    expect(lines).toEqual([])
  })
})

describe('links', () => {
  it('つながっているとき、何も出さず 0 で終わる', async () => {
    expect(await call('links', '--root', await materialize('valid'))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('失敗があると、1 件ごとに 1 行を標準エラーに出して 1 で終わる', async () => {
    expect(await call('links', '--root', await materialize('links-coverage-off'))).toEqual({
      code: 1,
      stdout: '',
      stderr: `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined\nerror: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined\n`,
    })
  })

  it('git リポジトリでない root だと、2 で終わる', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    try {
      await cp(path.join(import.meta.dirname, 'fixtures', 'links-coverage-off'), root, { recursive: true })
      expect(await call('links', '--root', root)).toEqual({
        code: 2,
        stdout: '',
        stderr: `error: ${root}: git ls-files failed (is it a git repository?)\n`,
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--root の値が無いと、使い方を出して 2 で終わる', async () => {
    const result = await call('links', '--root')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('interface-spec links')
  })
})
