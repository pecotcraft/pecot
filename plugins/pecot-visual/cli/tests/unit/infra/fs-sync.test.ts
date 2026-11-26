// infra/slidev-project/fs.ts の sync helper 群を、一時 dir で単独検証する。
// 対象は次の関数。
// `removeTemplateEntries`、`writeGeneratedFiles`、`talkDirectoryExists`、`hasSlidesMd`。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'

import {
  hasSlidesMd,
  removeTemplateEntries,
  talkDirectoryExists,
  syncGeneratedFiles,
  writeGeneratedFiles,
} from '../../../src/infra/slidev-project/fs.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import { explains } from '../../_helpers/explains.js'

const state = { temporaryRoot: '' }

beforeEach(() => {
  state.temporaryRoot = mkdtempSync(path.join(tmpdir(), 'pecotv-fs-sync-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(state.temporaryRoot, { recursive: true, force: true })
})

// 移行で消す名前。実装の一覧とは別に、期待値としてここに書く。
const ROOT_DIRECTORIES = ['components', 'composables', 'layouts', 'setup', 'styles', 'utils', 'scripts', 'patches', 'html-base', '.vite']
const ROOT_FILES = [
  'global-bottom.vue', 'eslint.config.js', 'deck-lint.config.js', '.npmrc',
  '.prettierrc.json', '.prettierignore', 'package-lock.json', 'pnpm-lock.yaml',
]
const NESTED = ['pages/_references', 'public/assets']

function seedTemplateCopy(talk: string): void {
  for (const name of ROOT_DIRECTORIES) {
    mkdirSync(path.join(talk, name, 'inner'), { recursive: true })
    writeFileSync(path.join(talk, name, 'inner', 'file.txt'), 'x')
  }
  for (const name of ROOT_FILES) writeFileSync(path.join(talk, name), 'x')
  for (const name of NESTED) {
    mkdirSync(path.join(talk, name), { recursive: true })
    writeFileSync(path.join(talk, name, 'file.txt'), 'x')
  }
}

function seedWork(talk: string): void {
  writeFileSync(path.join(talk, 'slides.md'), 'SLIDES')
  writeFileSync(path.join(talk, 'package.json'), 'PACKAGE')
  writeFileSync(path.join(talk, '.gitignore'), 'node_modules\n')
  writeFileSync(path.join(talk, 'pages', 'cover.md'), 'COVER')
  mkdirSync(path.join(talk, 'pages', '_custom'), { recursive: true })
  writeFileSync(path.join(talk, 'pages', '_custom', 'mine.md'), 'MINE')
  mkdirSync(path.join(talk, 'public', 'slides', 'images'), { recursive: true })
  writeFileSync(path.join(talk, 'public', 'slides', 'images', 'a.png'), 'PNG')
  mkdirSync(path.join(talk, 'pptx', 'cache'), { recursive: true })
  writeFileSync(path.join(talk, 'pptx', 'cache', 'manifest.json'), '{}')
  mkdirSync(path.join(talk, 'node_modules', 'vue'), { recursive: true })
}

describe('removeTemplateEntries', () => {
  it('テンプレート由来のファイルとディレクトリをすべて削除し、削除した名前を返す', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。移行で消す対象の名前をすべて置いた talk-dir を渡した場合に、それらがすべて存在しなくなり、削除した名前の一覧を返すことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    seedTemplateCopy(talk)
    seedWork(talk)

    const removed = await removeTemplateEntries(talk)

    expect([...removed].toSorted(compareStrings)).toStrictEqual([...ROOT_DIRECTORIES, ...ROOT_FILES, ...NESTED].toSorted(compareStrings))
    for (const name of [...ROOT_DIRECTORIES, ...ROOT_FILES, ...NESTED]) {
      expect(existsSync(path.join(talk, name)), `${name} が残っている`).toBe(false)
    }
  })

  it('作品・生成物・.gitignore・node_modules・親ディレクトリは、削除せずに残す', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。`slides.md`・`package.json`・`.gitignore`・`pages/` と `public/` の中の作品・`node_modules` を置いた場合に、どれも内容を変えずに残ることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    seedTemplateCopy(talk)
    seedWork(talk)

    await removeTemplateEntries(talk)

    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toBe('SLIDES')
    expect(readFileSync(path.join(talk, 'package.json'), 'utf8')).toBe('PACKAGE')
    expect(readFileSync(path.join(talk, '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(readFileSync(path.join(talk, 'pages', 'cover.md'), 'utf8')).toBe('COVER')
    expect(readFileSync(path.join(talk, 'pages', '_custom', 'mine.md'), 'utf8')).toBe('MINE')
    expect(readFileSync(path.join(talk, 'public', 'slides', 'images', 'a.png'), 'utf8')).toBe('PNG')
    expect(readFileSync(path.join(talk, 'pptx', 'cache', 'manifest.json'), 'utf8')).toBe('{}')
    expect(statSync(path.join(talk, 'node_modules', 'vue')).isDirectory()).toBe(true)
  })

  it('存在しない名前は飛ばして一覧に含めず、2 回目の実行では何も削除しない', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。`layouts` と `.npmrc` だけがある場合に、1 回目はその 2 つを返し、2 回目は空の配列を返すことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    mkdirSync(path.join(talk, 'layouts'))
    writeFileSync(path.join(talk, '.npmrc'), 'x')

    expect(await removeTemplateEntries(talk)).toStrictEqual(['layouts', '.npmrc'])
    expect(await removeTemplateEntries(talk)).toStrictEqual([])
  })

  it('親の pages や public が存在しなくても、エラーにならない', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。`pages` と `public` が存在しない talk-dir を渡した場合に、例外が発生せず、空の配列を返すことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })

    expect(await removeTemplateEntries(talk)).toStrictEqual([])
  })

  it('入れ子の名前の親がシンボリックリンクなら、リンク先の中は削除しない', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。`pages` が外部のディレクトリへのシンボリックリンクで、その先に `_references` がある場合に、何も削除せず、リンク先のファイルが残ることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    const outside = path.join(state.temporaryRoot, 'outside')
    mkdirSync(path.join(outside, '_references'), { recursive: true })
    writeFileSync(path.join(outside, '_references', 'keep.yaml'), 'KEEP')
    mkdirSync(talk, { recursive: true })
    symlinkSync(outside, path.join(talk, 'pages'), 'dir')

    const removed = await removeTemplateEntries(talk)

    expect(removed).toStrictEqual([])
    expect(readFileSync(path.join(outside, '_references', 'keep.yaml'), 'utf8')).toBe('KEEP')
  })

  it('名前そのものがシンボリックリンクなら、リンクだけを削除し、リンク先は削除しない', async () => {
    await explains('talk-dir からテンプレート由来のファイルを消す `removeTemplateEntries` のテストです。`layouts` が外部のディレクトリへのシンボリックリンクの場合に、リンクだけを削除して `layouts` を返し、リンク先のファイルが残ることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    const outside = path.join(state.temporaryRoot, 'outside-layouts')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'keep.vue'), 'KEEP')
    mkdirSync(talk, { recursive: true })
    symlinkSync(outside, path.join(talk, 'layouts'), 'dir')

    const removed = await removeTemplateEntries(talk)

    expect(removed).toStrictEqual(['layouts'])
    expect(() => lstatSync(path.join(talk, 'layouts'))).toThrow()
    expect(readFileSync(path.join(outside, 'keep.vue'), 'utf8')).toBe('KEEP')
  })
})

describe('writeGeneratedFiles', () => {
  it('vite.config.ts と start.mjs を本体の生成内容で書き、同名のファイルがあれば置き換える', async () => {
    await explains('talk-dir に生成ファイルを書く `writeGeneratedFiles` のテストです。古い内容の `vite.config.ts` と `start.mjs` がある場合に、`viteConfigSource` と `START_SCRIPT_SOURCE` の内容に書き換えることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'vite.config.ts'), 'OLD-VITE')
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START')

    await writeGeneratedFiles(talk, { themeName: 'slidev-theme-x' })

    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource({ themeName: 'slidev-theme-x' }))
    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)
  })

  it('start.mjs は、実行権限を付けて書く', async () => {
    await explains('talk-dir に生成ファイルを書く `writeGeneratedFiles` のテストです。実行権限のない `start.mjs` がある場合に、書き込んだ後のファイルのモードが `0o755` になることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START', { mode: 0o644 })

    await writeGeneratedFiles(talk, {})

    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })
})

describe('syncGeneratedFiles', () => {
  const options = { themeName: 'slidev-theme-x' }

  it('内容が違うファイルだけを本体の現在の内容で書き直し、書いたファイル名を返す', async () => {
    await explains('生成ファイルを本体の内容と同期する `syncGeneratedFiles` のテストです。`vite.config.ts` が古く、`start.mjs` が最新の場合に、`vite.config.ts` だけを書き直して返すことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'vite.config.ts'), 'OLD-CONFIG')
    writeFileSync(path.join(talk, 'start.mjs'), START_SCRIPT_SOURCE, { mode: 0o755 })

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual(['vite.config.ts'])
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource(options))
    expect(readdirSync(talk).toSorted(compareStrings)).toStrictEqual(['start.mjs', 'vite.config.ts'])
  })

  it('内容が同じなら、書き込まず、更新時刻も変えない', async () => {
    await explains('生成ファイルを本体の内容と同期する `syncGeneratedFiles` のテストです。すでに同期済みのファイルに対して再度実行した場合に、何も書かずに空の配列を返し、更新時刻が変わらないことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    await syncGeneratedFiles(talk, options)
    utimesSync(path.join(talk, 'vite.config.ts'), 1, 1)
    utimesSync(path.join(talk, 'start.mjs'), 1, 1)

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual([])
    expect(statSync(path.join(talk, 'vite.config.ts')).mtimeMs).toBe(1000)
    expect(statSync(path.join(talk, 'start.mjs')).mtimeMs).toBe(1000)
  })

  it('改行を CRLF に変えただけの違いは、書き直さない', async () => {
    await explains('生成ファイルを本体の内容と同期する `syncGeneratedFiles` のテストです。`vite.config.ts` の改行だけを CRLF にした場合は、内容が同じとみなされ、何も書かずに空の配列を返すことを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    await syncGeneratedFiles(talk, options)
    writeFileSync(path.join(talk, 'vite.config.ts'), viteConfigSource(options).replaceAll('\n', '\r\n'))

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual([])
  })

  it('存在しないファイルは作成し、start.mjs には実行権限を付ける', async () => {
    await explains('生成ファイルを本体の内容と同期する `syncGeneratedFiles` のテストです。ファイルが何もない talk-dir を渡した場合に、`vite.config.ts` と `start.mjs` を作成して返し、`start.mjs` のモードが `0o755` になることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual(['vite.config.ts', 'start.mjs'])
    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })

  it('実行権限のない start.mjs を書き直す場合も、実行権限を付ける', async () => {
    await explains('生成ファイルを本体の内容と同期する `syncGeneratedFiles` のテストです。実行権限のない古い `start.mjs` がある場合に、最新の内容に書き直し、モードを `0o755` にすることを確認します。')
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START', { mode: 0o644 })

    await syncGeneratedFiles(talk, options)

    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)
    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })
})

describe('talkDirectoryExists', () => {
  it('ディレクトリが存在しない場合は、exists を false にする', async () => {
    await explains('talk-dir の存在を調べる `talkDirectoryExists` のテストです。存在しないパスを渡した場合に、`exists` と `isDirectory` がどちらも `false` になることを確認します。')
    const result = await talkDirectoryExists(path.join(state.temporaryRoot, 'absent'))
    expect(result.exists).toBe(false)
    expect(result.isDirectory).toBe(false)
  })

  it('ディレクトリが存在する場合は、isDirectory を true にする', async () => {
    await explains('talk-dir の存在を調べる `talkDirectoryExists` のテストです。存在するディレクトリを渡した場合に、`exists` と `isDirectory` がどちらも `true` になることを確認します。')
    const directory = path.join(state.temporaryRoot, 'present')
    mkdirSync(directory)
    const result = await talkDirectoryExists(directory)
    expect(result.exists).toBe(true)
    expect(result.isDirectory).toBe(true)
  })

  it('パスが存在してもファイルの場合は、isDirectory を false にする', async () => {
    await explains('talk-dir の存在を調べる `talkDirectoryExists` のテストです。存在するファイルを渡した場合に、`exists` が `true`、`isDirectory` が `false` になることを確認します。')
    const file = path.join(state.temporaryRoot, 'somefile')
    writeFileSync(file, '')
    const result = await talkDirectoryExists(file)
    expect(result.exists).toBe(true)
    expect(result.isDirectory).toBe(false)
  })
})

describe('hasSlidesMd', () => {
  it('slides.md が存在しなければ、false を返す', async () => {
    await explains('slides.md の存在を調べる `hasSlidesMd` のテストです。`slides.md` がないディレクトリを渡した場合に、`false` を返すことを確認します。')
    const directory = path.join(state.temporaryRoot, 'd')
    mkdirSync(directory)
    expect(await hasSlidesMd(directory)).toBe(false)
  })

  it('slides.md が存在すれば、true を返す', async () => {
    await explains('slides.md の存在を調べる `hasSlidesMd` のテストです。`slides.md` があるディレクトリを渡した場合に、`true` を返すことを確認します。')
    const directory = path.join(state.temporaryRoot, 'd2')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'slides.md'), '')
    expect(await hasSlidesMd(directory)).toBe(true)
  })
})
