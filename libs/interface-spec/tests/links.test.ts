import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { checkLinks, scanBehaviorIds } from '../src/domain/links.js'
import { linkRepository } from '../src/links-repository.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

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
  it('行ごとに ID と行番号を返し、コメントの中も数える', async () => {
    await explains('テストのソースから振る舞いの項目の ID を探す `scanBehaviorIds` のテストです。`PA-` を含む複数の接頭辞の ID を含むソースの場合に、ID と行番号の組を出現順に返し、コメントの中の ID も含まれることを確認します。')
    const found = stepSync('ID を走査する', () => scanBehaviorIds({ path: 'a.test.ts', text: `verifies(ctx, 'PT-AWS-S3-LS-01')\n// PW-ISSUE-CREATE-02 と PV-DRAWIO-01\nPA-BOARD-SYNC-03\n` }))
    stepSync('結果を比べる', () => {
      expect(found).toEqual([
        { id: 'PT-AWS-S3-LS-01', line: 1 },
        { id: 'PW-ISSUE-CREATE-02', line: 2 },
        { id: 'PV-DRAWIO-01', line: 2 },
        { id: 'PA-BOARD-SYNC-03', line: 3 },
      ])
    })
  })

  it('桁が多い ID や、前後に文字が付いた ID は、拾わない', async () => {
    await explains('テストのソースから振る舞いの項目の ID を探す `scanBehaviorIds` のテストです。`PT-X-011` や `xPW-A-01` のように、桁が多い ID と前後に文字が付いた ID だけを含むソースの場合に、空の配列を返すことを確認します。')
    const text = 'PT-X-011 xPW-A-01 a_PW-A-01 -PW-A-01 PW-A-01x PW-A-01_ PW-A-01-\n'
    stepSync('ID を走査して比べる', () => {
      expect(scanBehaviorIds({ path: 'a.test.ts', text })).toEqual([])
    })
  })

  it('記号や空白に挟まれた ID は、拾って返す', async () => {
    await explains('テストのソースから振る舞いの項目の ID を探す `scanBehaviorIds` のテストです。`("PW-A-01"),[PW-B-02]` のように記号に挟まれた ID を含むソースの場合に、2 つの ID を返すことを確認します。')
    stepSync('ID を走査して比べる', () => {
      expect(scanBehaviorIds({ path: 'a.test.ts', text: '("PW-A-01"),[PW-B-02]' }).map(item => item.id)).toEqual(['PW-A-01', 'PW-B-02'])
    })
  })
})

describe('checkLinks', () => {
  it('coverage が off だと、テストが無い項目を報告しない', async () => {
    await explains('定義書の ID とテストの ID のつなぎを検証する `checkLinks` のテストです。`coverage` が `off` の場合に、テストが 1 件もない項目があっても、エラーを返さないことを確認します。')
    stepSync('リンクを確かめて比べる', () => {
      expect(checkLinks([{ name: 'pecot-tools', coverage: 'off', ids: ['PT-A-01'], tests: [] }])).toEqual([])
    })
  })

  it('エラーをファイル・行・ID の順に並べ、続けてテストが無い項目を ID の順に並べて返す', async () => {
    await explains('定義書の ID とテストの ID のつなぎを検証する `checkLinks` のテストです。定義書に存在しない ID と、テストのない項目が複数ある場合に、前者をファイル・行・ID の順、後者を ID の順に並べ、前者を先にして返すことを確認します。')
    const lines = stepSync('リンクを確かめる', () => checkLinks([{
      name: 'pecot-tools',
      coverage: 'on',
      ids: ['PT-B-01', 'PT-A-01', 'PT-C-01'],
      tests: [
        { path: 'b.test.ts', text: 'PT-Z-01\nPT-C-01\n' },
        { path: 'a.test.ts', text: 'PT-Y-01 PT-X-01\n\nPT-W-01' },
      ],
    }]))
    stepSync('結果を比べる', () => {
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
})

describe('linkRepository', () => {
  it('定義書に存在しない ID を、ファイルと行を付けて報告し、別の plugin の ID も存在しない扱いにする', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。ファイルと行を付けて報告し、別の plugin の ID を使っている場合も存在しないものとして報告することを確認します。')
    const lines = await step('リポジトリのリンクを確かめる', async () => await linkRepository(await materialize('links-coverage-off')))
    stepSync('結果を比べる', () => {
      expect(lines).toEqual([
        `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined`,
        `error: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined`,
      ])
    })
  })

  it('coverage が on だと、どのテストからも参照されていない項目も報告する', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。`coverage` が `on` の場合に、存在しない ID に加えて、どのテストからも参照されていない項目を `has no test` として報告することを確認します。')
    const lines = await step('リポジトリのリンクを確かめる', async () => await linkRepository(await materialize('links')))
    stepSync('結果を比べる', () => {
      expect(lines).toEqual([
        `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined`,
        `error: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined`,
        'error: PW-COMMON-01 has no test',
        'error: PW-ISSUE-CREATE-02 has no test',
        'error: PW-ISSUE-QUICK-01 has no test',
      ])
    })
  })

  it('statement が空の項目の ID も定義書の ID として扱い、テストに書いた同じ ID を存在しないと報告しない', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。`statement` が空の項目も定義書の ID に含まれ、テストに書いた同じ ID が、存在しないと報告されないことを確認します。')
    const root = await materialize('field-empty')
    await step('targets.json を書く', async () => {
      await writeFile(path.join(root, 'libs/interface-spec/targets.json'), JSON.stringify({
        format: 1,
        plugins: { 'pecot-workflow': { entries: 'complete', coverage: 'off', sources: [], tests: ['plugins/pecot-workflow/cli/tests/*.txt'] } },
      }))
    })
    await step('テストの置き場を作る', async () => {
      await mkdir(path.join(root, 'plugins/pecot-workflow/cli/tests'), { recursive: true })
    })
    await step('テストを書く', async () => {
      await writeFile(path.join(root, 'plugins/pecot-workflow/cli/tests/c.txt'), 'PW-ISSUE-CREATE-02\n')
    })
    stepSync('git に追跡させる', () => {
      execFileSync('git', ['add', '--all'], { cwd: root })
    })
    await step('リポジトリのリンクを確かめる、結果を比べる', async () => {
      expect(await linkRepository(root)).toEqual([])
    })
  })

  it('root を持つプラグインは、root の下の定義書とテストを読む', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。`targets.json` で `root` を指定したプラグインの場合に、`root` の下の定義書とテストを読み込み、報告が空になることを確認します。')
    const root = await step('fixture を展開する', () => materialize('links'))
    await step('定義書を root の下に移し、targets.json に root を書く', async () => {
      await mkdir(path.join(root, 'actions/tests'), { recursive: true })
      await rename(path.join(root, 'plugins/pecot-workflow/interface'), path.join(root, 'actions/interface'))
      await writeFile(path.join(root, 'libs/interface-spec/targets.json'), JSON.stringify({
        format: 1,
        plugins: { 'pecot-workflow': { root: 'actions', entries: 'complete', coverage: 'on', sources: [], tests: ['tests/*.txt'] } },
      }))
      await writeFile(path.join(root, 'actions/tests/a.txt'), 'PW-COMMON-01\nPW-ISSUE-CREATE-02\nPW-ISSUE-QUICK-01\nPW-ISSUE-CREATE-01\n')
    })
    stepSync('git に追跡させる', () => {
      execFileSync('git', ['add', '--all'], { cwd: root })
    })
    await step('リポジトリのリンクを確かめる、結果を比べる', async () => {
      expect(await linkRepository(root)).toEqual([])
    })
  })

  it('git が追跡しないファイルは読まない', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。`git add` していないファイルに存在しない ID が書かれていても、報告に含まれないことを確認します。')
    const root = await materialize('links-coverage-off')
    await step('追跡されないファイルを書く', async () => {
      await writeFile(path.join(root, 'plugins/pecot-tools/cli/tests/untracked.txt'), 'PT-UNTRACKED-01\n')
    })
    const lines = await step('リポジトリのリンクを確かめる', () => linkRepository(root))
    stepSync('結果を比べる', () => {
      expect(lines.some(line => line.includes('PT-UNTRACKED-01'))).toBe(false)
    })
  })

  it('targets.json の形式が不正だと、targets.json のエラーだけを返す', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。形式の不正な `targets.json` を渡した場合に、エラーが 1 件以上返り、すべて `libs/interface-spec/targets.json` に関するものであることを確認します。')
    const lines = await step('リポジトリのリンクを確かめる', async () => await linkRepository(await materialize('targets-invalid')))
    stepSync('結果を比べる', () => {
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.every(line => line.startsWith('error: libs/interface-spec/targets.json'))).toBe(true)
    })
  })

  it('authored.yaml が存在しない plugin は、定義書の ID を持たないものとして扱う', async () => {
    await explains('リポジトリのテストから、定義書に存在しない ID を探す `linkRepository` のテストです。`authored.yaml` が存在しない plugin を含む場合に、エラーが返らないことを確認します。')
    const lines = await step('リポジトリのリンクを確かめる', async () => await linkRepository(await materialize('interface-missing')))
    stepSync('結果を比べる', () => {
      expect(lines).toEqual([])
    })
  })
})

describe('links', () => {
  it('定義書とテストの ID がつながっていると、何も出力せず 0 で終了する', async () => {
    await explains('`interface-spec links` コマンドのテストです。定義書とテストの ID が整合している場合に、何も出力せず、終了コード 0 で終了することを確認します。')
    await step('リンクの確認を動かし、出力を比べる', async () => {
      expect(await call('links', '--root', await materialize('valid'))).toEqual({ code: 0, stdout: '', stderr: '' })
    })
  })

  it('エラーがあると、1 件ごとに 1 行を標準エラーに出力し、1 で終了する', async () => {
    await explains('`interface-spec links` コマンドのテストです。定義書に存在しない ID が 2 件ある場合、1 件ごとに 1 行を標準エラーへ出力し、終了コード 1 で終了することを確認します。')
    await step('リンクの確認を動かし、出力を比べる', async () => {
      expect(await call('links', '--root', await materialize('links-coverage-off'))).toEqual({
        code: 1,
        stdout: '',
        stderr: `error: ${TOOLS_FILE}:4: PT-AWS-S3-LS-99 is not defined\nerror: ${WORKFLOW_FILE}:2: PT-COMMON-01 is not defined\n`,
      })
    })
  })

  it('root が git リポジトリでないと、エラーを出力し、2 で終了する', async () => {
    await explains('`interface-spec links` コマンドのテストです。`--root` に git リポジトリでないディレクトリを指定した場合に、`git ls-files` の失敗を示すエラーを出力し、終了コード 2 で終了することを確認します。')
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    await step('git でない root の確認を動かし、出力を比べる', async () => {
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
  })

  it('--root の値が指定されていないと、使い方を出力し、2 で終了する', async () => {
    await explains('`interface-spec links` コマンドのテストです。`--root` に値を指定しなかった場合に、使い方を標準エラーへ出力し、終了コード 2 で終了することを確認します。')
    const result = await step('CLI を動かす', () => call('links', '--root'))
    stepSync('結果を比べる', () => {
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('interface-spec links')
    })
  })
})
