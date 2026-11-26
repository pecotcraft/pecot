import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoadError, loadJson, loadSources, loadYaml } from '../src/infra/load.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

describe('loadJson and loadYaml', () => {
  it('ファイルが存在しないと、missing の状態を返す', async () => {
    await explains('JSON と YAML のファイルを読み込む `loadJson` と `loadYaml` のテストです。ファイルが存在しない場合に、どちらも `{ kind: \'missing\' }` を返すことを確認します。')
    const root = await materialize('empty')
    await step('存在しないファイルを読み込み、結果を比べる', async () => {
      expect(await loadJson(path.join(root, 'none.json'))).toEqual({ kind: 'missing' })
      expect(await loadYaml(path.join(root, 'none.yaml'))).toEqual({ kind: 'missing' })
    })
  })

  it('ファイルが存在しない以外の読み取りエラーは、例外として投げる', async () => {
    await explains('JSON と YAML のファイルを読み込む `loadJson` と `loadYaml` のテストです。ファイルでなくディレクトリを渡した場合に、`EISDIR` を含む例外が発生することを確認します。')
    const root = await materialize('empty')
    await step('ディレクトリを読み込み、失敗を比べる', async () => {
      await expect(loadJson(root)).rejects.toThrow(/EISDIR/u)
    })
  })

  it('json と yaml のファイルを読み込むと、ok の状態とパースしたデータを返す', async () => {
    await explains('JSON と YAML のファイルを読み込む `loadJson` と `loadYaml` のテストです。内容が正しい JSON と YAML のファイルを渡した場合に、どちらも `ok` の状態と、解析したデータを返すことを確認します。')
    const root = await materialize('empty')
    await step('json と yaml を書く', async () => {
      await writeFile(path.join(root, 'a.json'), '{"a":1}')
      await writeFile(path.join(root, 'a.yaml'), 'a: 1\n')
    })
    await step('読み込んで結果を比べる', async () => {
      expect(await loadJson(path.join(root, 'a.json'))).toEqual({ kind: 'ok', data: { a: 1 } })
      expect(await loadYaml(path.join(root, 'a.yaml'))).toEqual({ kind: 'ok', data: { a: 1 } })
    })
  })

  it('YAML に構文エラーが複数あると、すべてのエラーに行番号を付けて返す', async () => {
    await explains('JSON と YAML のファイルを読み込む `loadJson` と `loadYaml` のテストです。キーの重複と括弧の閉じ忘れが 1 つずつある YAML を渡した場合に、`syntax` の状態で、2 行目と 4 行目のエラーを返すことを確認します。')
    const root = await materialize('empty')
    await step('yaml を書く', async () => {
      await writeFile(path.join(root, 'a.yaml'), 'a: 1\na: 2\nb: [\n')
    })
    const state = await step('yaml を読み込む', () => loadYaml(path.join(root, 'a.yaml')))
    stepSync('種類を比べる', () => {
      expect(state.kind).toBe('syntax')
    })
    if (state.kind !== 'syntax') return
    stepSync('エラーの行を比べる', () => {
      expect(state.problems.map(problem => problem.line)).toEqual([2, 4])
      expect(state.problems[0]?.message).toBe('map keys must be unique')
    })
  })
})

describe('loadSources', () => {
  it('glob が指定されていないと、ソースを 1 件も読み込まない', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。glob を 1 つも渡さなかった場合に、空の配列を返すことを確認します。')
    await step('glob が無いときの読み込みを比べる', async () => {
      expect(await loadSources(await materialize('valid'), 'plugins/pecot-workflow', [])).toEqual([])
    })
  })

  it('glob に一致し、git が追跡しているファイルだけを、パスの順に読み込む', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。追跡されていないファイルも一致する glob の場合、追跡されているファイルだけがパスの順に返り、内容も読み込まれることを確認します。')
    const root = await materialize('valid')
    await step('無視されるファイルを置く', async () => {
      await mkdir(path.join(root, 'plugins/pecot-workflow/cli/node_modules'), { recursive: true })
      await writeFile(path.join(root, 'plugins/pecot-workflow/cli/node_modules/ignored.py'), 'x = 1\n')
    })
    const sources = await step('ソースを読み込む', () => loadSources(root, 'plugins/pecot-workflow', ['cli/**/*.py']))
    stepSync('結果を比べる', () => {
      expect(sources.map(source => source.path)).toEqual(['plugins/pecot-workflow/cli/core/session.py'])
      expect(sources[0]?.text).toContain('PECOT_GITHUB_API_URL')
    })
  })

  it('glob が ../../ で plugin の外を指すと、リポジトリ内のライブラリのファイルも読み込む', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。`../../libs/core/src/*.ts` のように plugin の外を指す glob を渡した場合に、リポジトリ内のライブラリのファイルも、パスの順に返ることを確認します。')
    const root = await materialize('valid')
    await step('ライブラリのファイルを置く', async () => {
      await mkdir(path.join(root, 'libs/core/src/tests'), { recursive: true })
      await writeFile(path.join(root, 'libs/core/src/auth.ts'), 'export const name = 1\n')
      await writeFile(path.join(root, 'libs/core/src/tests/auth.test.ts'), 'export {}\n')
    })
    stepSync('git に追跡させる', () => {
      execFileSync('git', ['add', '--all'], { cwd: root })
    })
    const sources = await step('ソースを読み込む', () => loadSources(root, 'plugins/pecot-workflow', ['cli/**/*.py', '../../libs/core/src/*.ts']))
    stepSync('結果を比べる', () => {
      expect(sources.map(source => source.path)).toEqual(['libs/core/src/auth.ts', 'plugins/pecot-workflow/cli/core/session.py'])
    })
  })

  it('glob がリポジトリの外を指すと、LoadError を投げる', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。`../../../outside/*.ts` のようにリポジトリの外を指す glob を渡した場合に、`LoadError` が発生することを確認します。')
    const root = await materialize('valid')
    await step('リポジトリの外の glob で読み込み、LoadError を比べる', async () => {
      await expect(loadSources(root, 'plugins/pecot-workflow', ['../../../outside/*.ts'])).rejects.toBeInstanceOf(LoadError)
    })
  })
})

describe('loadSources with a missing or broken repository', () => {
  it('git に登録されていても作業ツリーに存在しないファイルは、読み込みの対象から外す', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。追跡されているファイルを作業ツリーから削除した場合に、そのファイルを読み込まず、空の配列を返すことを確認します。')
    const root = await materialize('valid')
    await step('追跡されるファイルを消す', async () => {
      await rm(path.join(root, 'plugins/pecot-workflow/cli/core/session.py'))
    })
    await step('ソースを読み込み、結果を比べる', async () => {
      expect(await loadSources(root, 'plugins/pecot-workflow', ['cli/**/*.py'])).toEqual([])
    })
  })

  it('root が git リポジトリでないと、LoadError を投げる', async () => {
    await explains('plugin のソースファイルを読み込む `loadSources` のテストです。git リポジトリでないディレクトリを root に指定した場合、`LoadError` が発生することを確認します。')
    const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-nogit-'))
    await step('git でない root を読み込み、LoadError を比べる', async () => {
      try {
        await expect(loadSources(root, 'plugins/pecot-workflow', ['**/*.py'])).rejects.toBeInstanceOf(LoadError)
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('syntax errors with a position', () => {
  it('不正な JSON は、エラーの行番号を付けて syntax の状態で返す', async () => {
    await explains('不正な JSON を読み込む `loadJson` のテストです。3 行目でカンマが抜けた JSON を渡した場合に、`syntax` の状態と、行番号 3 のエラーを返すことを確認します。')
    const root = await materialize('empty')
    await step('読めない json を書く', async () => {
      await writeFile(path.join(root, 'a.json'), '{\n"a": 1\n"b": 2}')
    })
    await step('読み込んで結果を比べる', async () => {
      expect(await loadJson(path.join(root, 'a.json'))).toEqual({ kind: 'syntax', problems: [{ line: 3, message: 'is not valid JSON' }] })
    })
  })

  it('YAML の alias の展開が過大になると、例外を投げず syntax の状態で返す', async () => {
    await explains('YAML を読み込む `loadYaml` のテストです。1 つの配列を 200 回参照するように alias の展開が過大になる場合、例外を投げず `syntax` の状態を返すことを確認します。')
    const root = await materialize('empty')
    const item = Array.from({ length: 20 }, (_, index) => String(index)).join(', ')
    const references = Array.from({ length: 200 }, () => '*a').join(', ')
    await step('alias の多い yaml を書く', async () => {
      await writeFile(path.join(root, 'a.yaml'), `a: &a [${item}]\nb: [${references}]\n`)
    })
    const state = await step('yaml を読み込む', () => loadYaml(path.join(root, 'a.yaml')))
    stepSync('種類を比べる', () => {
      expect(state.kind).toBe('syntax')
    })
  })
})
