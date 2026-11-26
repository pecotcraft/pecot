// linkNodeModules の張り方を固定する。
// talk-dir の node_modules は実ディレクトリで、項目ごとに依存ルートかテーマの置き場へ相対 symlink を張る。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { SlideCreateRuntimeError } from '../../../domain/slidev-project/errors.js'
import { isNodeModulesLinkCurrent, linkNodeModules } from '../fs.js'
import { seedDependencyRoot, writeFakePackage } from '../../../../tests/_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const temporaryRoot = useTemporaryDirectory('pecotv-node-modules-', { resolveRealPath: true })

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

/**
依存ルートを作る。probe に加えて、`.bin`、`@scope/pkg`、張ってはならない `.pnpm` と `.modules.yaml` を足す。
*/
function seedFullDependencyRoot(root: string): string {
  const nodeModules = seedDependencyRoot(root, ['plain-pkg', '@scope/pkg'])
  mkdirSync(path.join(nodeModules, '.bin'), { recursive: true })
  writeFileSync(path.join(nodeModules, '.bin', 'slidev'), '#!/bin/sh\n')
  mkdirSync(path.join(nodeModules, '.pnpm'), { recursive: true })
  writeFileSync(path.join(nodeModules, '.modules.yaml'), 'layoutVersion: 5\n')
  mkdirSync(path.join(nodeModules, '.vite'), { recursive: true })
  return nodeModules
}

function makeTalk(name: string): string {
  const talk = temporaryRoot(name)
  mkdirSync(talk, { recursive: true })
  return talk
}

function makeThemeDirectory(name: string): string {
  const directory = temporaryRoot('store', name, 'package')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name }))
  return directory
}

function readLinkMark(talk: string): unknown {
  return JSON.parse(readFileSync(path.join(talk, 'node_modules', '.pecotv-link.json'), 'utf8'))
}

function listNames(directory: string): readonly string[] {
  return readdirSync(directory).toSorted(compareStrings)
}

describe('linkNodeModules (依存ルートの項目)', () => {
  it('node_modules を実ディレクトリにし、各項目を物理パスへ解決する相対 symlink で張る', async () => {
    await explains('`linkNodeModules` が作成する `node_modules` のテストです。実ディレクトリになり、`plain-pkg` や `@slidev` などの各項目が、依存ルートの物理パスへ解決する相対 symlink になることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')

    const result = await linkNodeModules(talk, pluginRoot, [])

    const nodeModules = path.join(talk, 'node_modules')
    const info = lstatSync(nodeModules)
    expect(info.isDirectory()).toBe(true)
    expect(info.isSymbolicLink()).toBe(false)
    for (const name of ['plain-pkg', '@slidev', 'dom-to-pptx']) {
      const link = path.join(nodeModules, name)
      const target = readlinkSync(link)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(path.isAbsolute(target)).toBe(false)
      expect(realpathSync(link)).toBe(realpathSync(path.join(dependencyNodeModules, name)))
    }
    expect(result.nodeModulesTarget).toBe(dependencyNodeModules)
  })

  it('.bin と @scope は 1 本の symlink で張る', async () => {
    await explains('`.bin` と `@scope` の張り方のテストです。どちらも配下を個別に張らず、依存ルートの同名の項目を指す 1 本の symlink になることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')

    await linkNodeModules(talk, pluginRoot, [])

    const bin = path.join(talk, 'node_modules', '.bin')
    const scope = path.join(talk, 'node_modules', '@scope')
    expect(lstatSync(bin).isSymbolicLink()).toBe(true)
    expect(lstatSync(scope).isSymbolicLink()).toBe(true)
    expect(realpathSync(bin)).toBe(path.join(dependencyNodeModules, '.bin'))
    expect(realpathSync(scope)).toBe(path.join(dependencyNodeModules, '@scope'))
  })

  it('依存ルートに .bin 以外のドットで始まる項目が存在する場合は、それらを張らない', async () => {
    await explains('`.pnpm`、`.modules.yaml`、`.vite` が依存ルートに存在する場合のテストです。`node_modules` には `.bin` と印のファイルだけが残り、張った項目の数に印のファイルを含めないことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')

    const result = await linkNodeModules(talk, pluginRoot, [])

    const names = listNames(path.join(talk, 'node_modules'))
    expect(names).not.toContain('.pnpm')
    expect(names).not.toContain('.modules.yaml')
    expect(names).not.toContain('.vite')
    expect(names).toStrictEqual([
      '.bin',
      '.pecotv-link.json',
      '@scope',
      '@slidev',
      'dom-to-pptx',
      'plain-pkg',
    ])
    // 数えるのは張った項目だけで、印のファイルは含めない。
    expect(result.entries).toBe(5)
  })

  it('依存ルートが runtime/current の symlink の場合は、current を経由する symlink を張り、世代を削除しても切れない', async () => {
    await explains('依存ルートが `runtime/current` の symlink である場合のテストです。張った symlink は世代名を含まず `current` を経由し、`current` が別の世代へ向き直って旧世代を削除しても、新しい世代へ解決することを確認します。')
    const dataDirectory = temporaryRoot('data')
    const runtimeDirectory = path.join(dataDirectory, 'runtime')
    const generation = path.join(runtimeDirectory, 'deps0-src0')
    seedFullDependencyRoot(generation)
    const currentLink = path.join(runtimeDirectory, 'current')
    symlinkSync('deps0-src0', currentLink, 'dir')
    const talk = makeTalk('talk-current')

    const result = await linkNodeModules(talk, currentLink, [])

    expect(result.nodeModulesTarget).toBe(path.join(runtimeDirectory, 'current', 'node_modules'))
    const link = path.join(talk, 'node_modules', '@slidev')
    const target = readlinkSync(link)
    expect(path.isAbsolute(target)).toBe(false)
    expect(target).toContain('current')
    expect(target).not.toContain('deps0-src0')
    expect(realpathSync(link)).toBe(path.join(generation, 'node_modules', '@slidev'))

    // current が別世代へ向き直り、旧世代が消えても、同じ symlink のまま新世代を指す。
    const nextGeneration = path.join(runtimeDirectory, 'deps0-src1')
    seedFullDependencyRoot(nextGeneration)
    rmSync(currentLink)
    symlinkSync('deps0-src1', currentLink, 'dir')
    rmSync(generation, { recursive: true, force: true })
    expect(realpathSync(link)).toBe(path.join(nextGeneration, 'node_modules', '@slidev'))
  })

  it('talkDirectory が symlink 経由のパスの場合も、物理パスを基準に相対パスを作成する', async () => {
    await explains('`talkDirectory` が symlink 経由のパスで渡された場合のテストです。張った symlink の相対パスが物理パスを基準に作られ、依存ルートの項目へ解決することを確認します。')
    const physicalRoot = temporaryRoot('physical')
    const pluginRoot = path.join(physicalRoot, 'plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const physicalTalk = path.join(physicalRoot, 'deep', 'talk')
    mkdirSync(physicalTalk, { recursive: true })
    const aliasTalk = temporaryRoot('alias-talk')
    symlinkSync(physicalTalk, aliasTalk, 'dir')

    await linkNodeModules(aliasTalk, pluginRoot, [])

    const link = path.join(physicalTalk, 'node_modules', 'plain-pkg')
    expect(path.resolve(path.dirname(link), readlinkSync(link))).toBe(path.join(dependencyNodeModules, 'plain-pkg'))
  })
})

describe('linkNodeModules (依存ルートの解決)', () => {
  it('plugin-root に node_modules が存在しない場合は、永続層の依存ルートへ張る', async () => {
    await explains('単体配布の plugin-root に `node_modules` が存在しない場合のテストです。環境変数 `CLAUDE_PLUGIN_DATA` 配下の依存ルートが張り先に選ばれ、その項目へ解決することを確認します。')
    const pluginRoot = temporaryRoot('dist-pkg')
    mkdirSync(pluginRoot, { recursive: true })
    const data = temporaryRoot('data')
    const runtimeNodeModules = seedFullDependencyRoot(path.join(data, 'mcp-dist'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const talk = makeTalk('talk-dist')

    const result = await linkNodeModules(talk, pluginRoot, [])

    expect(result.nodeModulesTarget).toBe(runtimeNodeModules)
    const link = path.join(talk, 'node_modules', 'plain-pkg')
    expect(path.isAbsolute(readlinkSync(link))).toBe(false)
    expect(realpathSync(link)).toBe(path.join(runtimeNodeModules, 'plain-pkg'))
  })

  it('node_modules が存在しても実行時の依存を解決できない場合は、永続層の依存ルートへ張る', async () => {
    await explains('plugin-root に空の `node_modules` が存在し、実行時の依存を解決できない場合のテストです。`CLAUDE_PLUGIN_DATA` 配下の依存ルートが張り先に選ばれることを確認します。')
    const pluginRoot = temporaryRoot('shallow-pkg')
    mkdirSync(path.join(pluginRoot, 'node_modules'), { recursive: true })
    const data = temporaryRoot('data-shallow')
    const runtimeNodeModules = seedFullDependencyRoot(path.join(data, 'mcp-dist'))
    vi.stubEnv('CLAUDE_PLUGIN_DATA', data)
    const talk = makeTalk('talk-shallow')

    const result = await linkNodeModules(talk, pluginRoot, [])

    expect(result.nodeModulesTarget).toBe(runtimeNodeModules)
    expect(realpathSync(path.join(talk, 'node_modules', 'plain-pkg'))).toBe(path.join(runtimeNodeModules, 'plain-pkg'))
  })

  it('どの依存ルートにも node_modules が存在しない場合は、symlink-failed で中止し、talk-dir を変更しない', async () => {
    await explains('依存ルートがどこにも存在しない場合のテストです。理由 `symlink-failed` の `SlideCreateRuntimeError` が発生し、既存の `node_modules` の内容が変更されないことを確認します。')
    const pluginRoot = temporaryRoot('no-deps')
    mkdirSync(pluginRoot, { recursive: true })
    vi.stubEnv('CLAUDE_PLUGIN_DATA', temporaryRoot('empty-data'))
    const talk = makeTalk('talk-nodeps')
    mkdirSync(path.join(talk, 'node_modules', 'keep'), { recursive: true })

    const run = linkNodeModules(talk, pluginRoot, [])

    await expect(run).rejects.toThrow(SlideCreateRuntimeError)
    await expect(run).rejects.toMatchObject({ reason: 'symlink-failed' })
    expect(listNames(path.join(talk, 'node_modules'))).toStrictEqual(['keep'])
  })
})

describe('linkNodeModules (張り直し)', () => {
  it('旧形の symlink 1 本の場合は、実ディレクトリに置き換え、依存ルートを削除しない', async () => {
    await explains('`node_modules` が依存ルートへの symlink 1 本である旧形のテストです。実ディレクトリへ置き換わり、依存ルートの中身が張る前と同じままであることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const before = listNames(dependencyNodeModules)
    const talk = makeTalk('talk')
    symlinkSync(path.relative(talk, dependencyNodeModules), path.join(talk, 'node_modules'), 'dir')

    await linkNodeModules(talk, pluginRoot, [])

    expect(lstatSync(path.join(talk, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(listNames(dependencyNodeModules)).toStrictEqual(before)
    expect(listNames(path.join(dependencyNodeModules, '@scope'))).toStrictEqual(['pkg'])
  })

  it('存在しない場所を指す絶対パスの symlink の場合も、張り直す', async () => {
    await explains('`node_modules` が存在しない場所を指す絶対パスの symlink である場合のテストです。実ディレクトリに置き換わり、各項目が相対 symlink で張られることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    symlinkSync('/abs/wrong', path.join(talk, 'node_modules'), 'dir')

    await linkNodeModules(talk, pluginRoot, [])

    expect(lstatSync(path.join(talk, 'node_modules')).isDirectory()).toBe(true)
    expect(readlinkSync(path.join(talk, 'node_modules', 'plain-pkg')).startsWith('/')).toBe(false)
  })

  it('実ディレクトリの中身を破棄して作り直し、2 回続けて実行しても同じ結果になる', async () => {
    await explains('`node_modules` が古い項目を含む実ディレクトリである場合のテストです。古い項目が残らず、2 回続けて実行しても一覧が一致し、依存ルートの項目が残ることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    mkdirSync(path.join(talk, 'node_modules', 'stale'), { recursive: true })
    writeFileSync(path.join(talk, 'node_modules', 'stale', 'index.js'), '')

    await linkNodeModules(talk, pluginRoot, [])
    const first = listNames(path.join(talk, 'node_modules'))
    await linkNodeModules(talk, pluginRoot, [])
    const second = listNames(path.join(talk, 'node_modules'))

    expect(first).not.toContain('stale')
    expect(second).toStrictEqual(first)
    expect(listNames(dependencyNodeModules)).toContain('plain-pkg')
  })

  it('張り直しのとき、実ディレクトリの中の symlink の先にある依存ルートの中身を削除しない', async () => {
    await explains('張り直しを 2 回続けて実行する場合のテストです。symlink の先にある依存ルートのファイルとディレクトリが、削除されずに残ることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')

    await linkNodeModules(talk, pluginRoot, [])
    await linkNodeModules(talk, pluginRoot, [])

    expect(readFileSync(path.join(dependencyNodeModules, 'plain-pkg', 'index.js'), 'utf8')).toBe('')
    expect(listNames(path.join(dependencyNodeModules, '@slidev'))).toContain('cli')
  })
})

describe('linkNodeModules (入れ替え)', () => {
  it('テーマの directory が存在せず中断した場合は、既存の node_modules を残す', async () => {
    await explains('テーマの `directory` が存在せず、張る処理が例外で中断する場合のテストです。既存の `node_modules` の内容が変わらず、`talk` に組み立て中のディレクトリが残らないことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    mkdirSync(path.join(talk, 'node_modules', 'keep'), { recursive: true })

    const run = linkNodeModules(talk, pluginRoot, [{ name: 'theme-x', directory: temporaryRoot('missing-theme') }])

    await expect(run).rejects.toThrow()
    expect(listNames(path.join(talk, 'node_modules'))).toStrictEqual(['keep'])
    expect(listNames(talk)).toStrictEqual(['node_modules'])
  })

  it('組み立ての途中で symlink の作成が失敗した場合は、組み立て中のものを削除し、既存を残す', async () => {
    await explains('テーマ名がファイルの項目の配下になり、組み立て中の作成が失敗する場合のテストです。組み立て中のディレクトリが削除され、既存の `node_modules` が変わらないことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    writeFileSync(path.join(dependencyNodeModules, 'single-file'), '')
    const talk = makeTalk('talk')
    mkdirSync(path.join(talk, 'node_modules', 'keep'), { recursive: true })
    // テーマ名がファイルの項目の配下になると、組み立て中の mkdir が失敗する。
    const directory = makeThemeDirectory('theme-a')

    const run = linkNodeModules(talk, pluginRoot, [{ name: 'single-file/inner', directory }])

    await expect(run).rejects.toThrow()
    expect(listNames(path.join(talk, 'node_modules'))).toStrictEqual(['keep'])
    expect(listNames(talk)).toStrictEqual(['node_modules'])
  })

  it('前回の異常終了で残った組み立て中と入れ替え前のディレクトリを、次の張り直しで削除する', async () => {
    await explains('`node_modules.tmp-` と `node_modules.old-` で始まる名前が前回の異常終了で残っている場合のテストです。次の張り直しで削除され、`talk` に `node_modules` だけが残ることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    mkdirSync(path.join(talk, 'node_modules.tmp-abc123', 'half'), { recursive: true })
    mkdirSync(path.join(talk, 'node_modules.old-def456', 'stale'), { recursive: true })
    symlinkSync(pluginRoot, path.join(talk, 'node_modules.old-ghi789'), 'dir')

    await linkNodeModules(talk, pluginRoot, [])

    expect(listNames(talk)).toStrictEqual(['node_modules'])
    expect(listNames(pluginRoot)).toContain('node_modules')
  })

  it('張り終えた後の node_modules は、最終の位置を基準に解決する相対 symlink となる', async () => {
    await explains('組み立て用の一時ディレクトリから入れ替えた後の、symlink のテストです。相対パスに `node_modules.tmp-` が含まれず、最終の位置を基準に依存ルートの項目へ解決することを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-s')

    await linkNodeModules(talk, pluginRoot, [{ name: '@scope/theme', directory }])

    const link = path.join(talk, 'node_modules', '@scope', 'pkg')
    expect(readlinkSync(link)).not.toContain('node_modules.tmp-')
    expect(path.resolve(path.dirname(link), readlinkSync(link))).toBe(path.join(dependencyNodeModules, '@scope', 'pkg'))
  })
})

describe('linkNodeModules (テーマ)', () => {
  it('テーマ名の項目を、テーマの置き場への相対 symlink で張る', async () => {
    await explains('テーマを 1 つ指定した場合のテストです。テーマ名の項目が置き場への相対 symlink になり、その中の `package.json` を読み出せることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-a')

    await linkNodeModules(talk, pluginRoot, [{ name: 'theme-a', directory }])

    const link = path.join(talk, 'node_modules', 'theme-a')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(path.isAbsolute(readlinkSync(link))).toBe(false)
    expect(realpathSync(link)).toBe(directory)
    expect(readFileSync(path.join(link, 'package.json'), 'utf8')).toBe(JSON.stringify({ name: 'theme-a' }))
  })

  it('依存ルートと同名のテーマを指定した場合は、テーマを優先し、依存ルートを変更しない', async () => {
    await explains('依存ルートの `plain-pkg` と同じ名前のテーマを指定した場合のテストです。`node_modules` の項目はテーマの置き場へ解決し、依存ルートの `package.json` は変更されないことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('plain-pkg')

    await linkNodeModules(talk, pluginRoot, [{ name: 'plain-pkg', directory }])

    expect(realpathSync(path.join(talk, 'node_modules', 'plain-pkg'))).toBe(directory)
    const original: unknown = JSON.parse(readFileSync(path.join(dependencyNodeModules, 'plain-pkg', 'package.json'), 'utf8'))
    expect(original).toMatchObject({ name: 'plain-pkg', version: '1.0.0' })
  })

  it('scope 付きのテーマ名の場合は、その scope だけを実ディレクトリにして、配下を 1 本ずつ張る', async () => {
    await explains('`@scope/theme` のような scope 付きのテーマ名を指定した場合のテストです。`@scope` が実ディレクトリになり、`theme` と依存ルートの `pkg` や `other` が並び、依存ルート側には `theme` が追加されないことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    writeFakePackage(pluginRoot, '@scope/other')
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-scoped')

    await linkNodeModules(talk, pluginRoot, [{ name: '@scope/theme', directory }])

    const scope = path.join(talk, 'node_modules', '@scope')
    expect(lstatSync(scope).isDirectory()).toBe(true)
    expect(lstatSync(scope).isSymbolicLink()).toBe(false)
    expect(listNames(scope)).toStrictEqual(['other', 'pkg', 'theme'])
    expect(realpathSync(path.join(scope, 'theme'))).toBe(directory)
    expect(lstatSync(path.join(scope, 'pkg')).isSymbolicLink()).toBe(true)
    expect(realpathSync(path.join(scope, 'pkg'))).toBe(path.join(dependencyNodeModules, '@scope', 'pkg'))
    expect(realpathSync(path.join(scope, 'other'))).toBe(path.join(dependencyNodeModules, '@scope', 'other'))
    // 依存ルートの @scope には theme を足さない。
    expect(listNames(path.join(dependencyNodeModules, '@scope'))).toStrictEqual(['other', 'pkg'])
  })

  it('依存ルートに存在しない scope のテーマ名の場合も、scope を作成して張る', async () => {
    await explains('依存ルートに存在しない `@fresh` の scope でテーマ名を指定した場合のテストです。`@fresh` が実ディレクトリとして作成され、配下にテーマだけが張られることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-fresh')

    await linkNodeModules(talk, pluginRoot, [{ name: '@fresh/theme', directory }])

    const scope = path.join(talk, 'node_modules', '@fresh')
    expect(lstatSync(scope).isDirectory()).toBe(true)
    expect(listNames(scope)).toStrictEqual(['theme'])
    expect(realpathSync(path.join(scope, 'theme'))).toBe(directory)
  })

  it('同じ scope のテーマが 2 つ指定された場合も、どちらも張る', async () => {
    await explains('`@scope/one` と `@scope/two` の 2 つのテーマを指定した場合のテストです。依存ルートの `pkg` を含めて 3 項目が並び、各テーマがそれぞれの置き場へ解決することを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const first = makeThemeDirectory('theme-one')
    const second = makeThemeDirectory('theme-two')

    await linkNodeModules(talk, pluginRoot, [
      { name: '@scope/one', directory: first },
      { name: '@scope/two', directory: second },
    ])

    const scope = path.join(talk, 'node_modules', '@scope')
    expect(listNames(scope)).toStrictEqual(['one', 'pkg', 'two'])
    expect(realpathSync(path.join(scope, 'one'))).toBe(first)
    expect(realpathSync(path.join(scope, 'two'))).toBe(second)
  })

  it('テーマの置き場が symlink 経由のパスの場合も、物理パスへ張る', async () => {
    await explains('テーマの `directory` が symlink 経由のパスで渡された場合のテストです。張った symlink の相対パスが、テーマの物理パスへ解決することを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-real')
    const alias = temporaryRoot('alias-theme')
    symlinkSync(directory, alias, 'dir')

    await linkNodeModules(talk, pluginRoot, [{ name: 'theme-real', directory: alias }])

    const link = path.join(talk, 'node_modules', 'theme-real')
    expect(path.resolve(path.dirname(link), readlinkSync(link))).toBe(directory)
  })
})

describe('linkNodeModules (.pecotv-link.json)', () => {
  it('current ではない依存ルートの場合は、印に物理パスとテーマの name と directory を書く', async () => {
    await explains('`.pecotv-link.json` の内容のテストです。`current` ではない依存ルートは種別 `path` の物理パスで、テーマは `name` と `directory` の組で記録されることを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-a')

    await linkNodeModules(talk, pluginRoot, [{ name: 'theme-a', directory }])

    const mark: unknown = readLinkMark(talk)
    expect(mark).toStrictEqual({
      runtime: { kind: 'path', value: dependencyNodeModules },
      themes: [{ name: 'theme-a', directory }],
    })
  })

  it('依存ルートが current の場合は、印に世代名を書く', async () => {
    await explains('依存ルートが `current` の symlink である場合の `.pecotv-link.json` のテストです。種別 `generation` で世代名 `deps0-src0` が記録されることを確認します。')
    const runtimeDirectory = temporaryRoot('data', 'runtime')
    seedFullDependencyRoot(path.join(runtimeDirectory, 'deps0-src0'))
    const currentLink = path.join(runtimeDirectory, 'current')
    symlinkSync('deps0-src0', currentLink, 'dir')
    const talk = makeTalk('talk-current')

    await linkNodeModules(talk, currentLink, [])

    expect(readLinkMark(talk)).toStrictEqual({ runtime: { kind: 'generation', value: 'deps0-src0' }, themes: [] })
  })
})

describe('isNodeModulesLinkCurrent (印との比較)', () => {
  it('印の依存ルートとテーマが現在の値と一致する場合は、true を返す', async () => {
    await explains('`isNodeModulesLinkCurrent` のテストです。張った直後に同じ依存ルートとテーマで呼び出した場合に、`true` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-a')
    const themes = [{ name: 'theme-a', directory }]
    await linkNodeModules(talk, pluginRoot, themes)

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, themes)).toBe(true)
  })

  it('テーマの directory が symlink 経由の別名でも、実体が同じ場合は、true を返す', async () => {
    await explains('テーマの `directory` を symlink 経由の別名で渡した場合のテストです。物理パスが印と一致するため、`true` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const directory = makeThemeDirectory('theme-a')
    const alias = temporaryRoot('alias')
    symlinkSync(directory, alias, 'dir')
    await linkNodeModules(talk, pluginRoot, [{ name: 'theme-a', directory }])

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [{ name: 'theme-a', directory: alias }])).toBe(true)
  })

  it('テーマの directory が変わった場合は、false を返す', async () => {
    await explains('張った後にテーマの `directory` を別の場所へ変えて呼び出した場合のテストです。印と一致しないため、`false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    await linkNodeModules(talk, pluginRoot, [{ name: 'theme-a', directory: makeThemeDirectory('theme-a') }])
    const other = temporaryRoot('store', 'other', 'package')
    mkdirSync(other, { recursive: true })

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [{ name: 'theme-a', directory: other }])).toBe(false)
  })

  it('テーマの数が印と異なる場合は、false を返す', async () => {
    await explains('テーマなしで張った後に、テーマを 1 つ指定して呼び出した場合のテストです。印のテーマの数と異なるため、`false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    await linkNodeModules(talk, pluginRoot, [])

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [{ name: 'theme-a', directory: makeThemeDirectory('theme-a') }])).toBe(false)
  })

  it('依存ルートの世代が変わった場合は、false を返す', async () => {
    await explains('依存ルートの `current` が別の世代を指す場合のテストです。同じ依存ルートの場合は `true`、別の世代の場合は `false` を返すことを確認します。')
    const runtimeDirectory = temporaryRoot('data', 'runtime')
    seedFullDependencyRoot(path.join(runtimeDirectory, 'deps0-src0'))
    const currentLink = path.join(runtimeDirectory, 'current')
    symlinkSync('deps0-src0', currentLink, 'dir')
    // current が別世代を指す、もう 1 つの置き場。同じ current の向き直しは、解決のキャッシュに阻まれて再現できない。
    const nextRuntimeDirectory = temporaryRoot('next-data', 'runtime')
    seedFullDependencyRoot(path.join(nextRuntimeDirectory, 'deps0-src1'))
    const nextCurrentLink = path.join(nextRuntimeDirectory, 'current')
    symlinkSync('deps0-src1', nextCurrentLink, 'dir')
    const talk = makeTalk('talk')
    await linkNodeModules(talk, currentLink, [])
    expect(await isNodeModulesLinkCurrent(talk, currentLink, [])).toBe(true)

    expect(await isNodeModulesLinkCurrent(talk, nextCurrentLink, [])).toBe(false)
  })

  it('印のファイルが存在しない旧形の symlink 1 本の場合は、false を返す', async () => {
    await explains('`node_modules` が依存ルートへの symlink 1 本で、印のファイルが存在しない旧形のテストです。`false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    const dependencyNodeModules = seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    symlinkSync(dependencyNodeModules, path.join(talk, 'node_modules'), 'dir')

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [])).toBe(false)
  })

  it('張り先が存在しない symlink と node_modules が存在しない場合は、false を返す', async () => {
    await explains('`node_modules` が存在しない場合と、存在しない場所を指す symlink である場合のテストです。どちらの場合も `false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [])).toBe(false)

    symlinkSync(temporaryRoot('missing'), path.join(talk, 'node_modules'), 'dir')
    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [])).toBe(false)
  })

  it('印が JSON として解析できない場合と、形式が異なる場合は、false を返す', async () => {
    await explains('印のファイルを不正な JSON にした場合と、`runtime` が数値になっている場合のテストです。どちらの場合も `false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    await linkNodeModules(talk, pluginRoot, [])
    const markPath = path.join(talk, 'node_modules', '.pecotv-link.json')

    writeFileSync(markPath, '{not json')
    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [])).toBe(false)

    writeFileSync(markPath, JSON.stringify({ runtime: 1, themes: [] }))
    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, [])).toBe(false)
  })

  it('テーマの項目が node_modules から削除されている場合は、false を返す', async () => {
    await explains('張った後にテーマの symlink を削除してから呼び出した場合のテストです。印は一致していても、項目が存在しないため `false` を返すことを確認します。')
    const pluginRoot = temporaryRoot('plugin')
    seedFullDependencyRoot(pluginRoot)
    const talk = makeTalk('talk')
    const themes = [{ name: 'theme-a', directory: makeThemeDirectory('theme-a') }]
    await linkNodeModules(talk, pluginRoot, themes)
    rmSync(path.join(talk, 'node_modules', 'theme-a'))

    expect(await isNodeModulesLinkCurrent(talk, pluginRoot, themes)).toBe(false)
  })
})
