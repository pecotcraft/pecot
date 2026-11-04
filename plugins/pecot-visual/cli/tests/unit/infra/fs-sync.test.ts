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
  it('テンプレート由来の名前を全部消し、消した名前を返す', async () => {
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

  it('作品・生成物・.gitignore・node_modules・親ディレクトリは残す', async () => {
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

  it('無い名前は飛ばし、返す一覧に入れない。2 回目は何も消さない', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    mkdirSync(path.join(talk, 'layouts'))
    writeFileSync(path.join(talk, '.npmrc'), 'x')

    expect(await removeTemplateEntries(talk)).toStrictEqual(['layouts', '.npmrc'])
    expect(await removeTemplateEntries(talk)).toStrictEqual([])
  })

  it('親の pages や public が無くても止まらない', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })

    expect(await removeTemplateEntries(talk)).toStrictEqual([])
  })

  it('入れ子の名前の親が symlink なら、向き先の中は消さない', async () => {
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

  it('名前そのものが symlink なら、リンクだけを消して向き先は消さない', async () => {
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
  it('vite.config.ts と start.mjs を本体の生成物で書き、既存の同名ファイルを置き換える', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'vite.config.ts'), 'OLD-VITE')
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START')

    await writeGeneratedFiles(talk, { themeName: 'slidev-theme-x' })

    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource({ themeName: 'slidev-theme-x' }))
    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)
  })

  it('start.mjs は実行権限を持つ', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START', { mode: 0o644 })

    await writeGeneratedFiles(talk, {})

    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })
})

describe('syncGeneratedFiles', () => {
  const options = { themeName: 'slidev-theme-x' }

  it('違うファイルだけを本体の今の内容で書き直し、書いたファイル名を返す', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'vite.config.ts'), 'OLD-CONFIG')
    writeFileSync(path.join(talk, 'start.mjs'), START_SCRIPT_SOURCE, { mode: 0o755 })

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual(['vite.config.ts'])
    expect(readFileSync(path.join(talk, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource(options))
    expect(readdirSync(talk).toSorted(compareStrings)).toStrictEqual(['start.mjs', 'vite.config.ts'])
  })

  it('同じ内容なら書かない（mtime も変わらない）', async () => {
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

  it('CRLF にそろえ直しただけの違いは書き直さない', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    await syncGeneratedFiles(talk, options)
    writeFileSync(path.join(talk, 'vite.config.ts'), viteConfigSource(options).replaceAll('\n', '\r\n'))

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual([])
  })

  it('無いファイルは作り、start.mjs には実行権限を付ける', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })

    const written = await syncGeneratedFiles(talk, options)

    expect(written).toStrictEqual(['vite.config.ts', 'start.mjs'])
    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })

  it('実行権限の無い start.mjs を書き直すときも、実行権限を付ける', async () => {
    const talk = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'start.mjs'), 'OLD-START', { mode: 0o644 })

    await syncGeneratedFiles(talk, options)

    expect(readFileSync(path.join(talk, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)
    expect(statSync(path.join(talk, 'start.mjs')).mode & 0o777).toBe(0o755)
  })
})

describe('talkDirectoryExists', () => {
  it('存在しない場合は exists=false', async () => {
    const result = await talkDirectoryExists(path.join(state.temporaryRoot, 'absent'))
    expect(result.exists).toBe(false)
    expect(result.isDirectory).toBe(false)
  })

  it('存在するディレクトリなら isDirectory=true', async () => {
    const directory = path.join(state.temporaryRoot, 'present')
    mkdirSync(directory)
    const result = await talkDirectoryExists(directory)
    expect(result.exists).toBe(true)
    expect(result.isDirectory).toBe(true)
  })

  it('存在するが file の場合 isDirectory=false', async () => {
    const file = path.join(state.temporaryRoot, 'somefile')
    writeFileSync(file, '')
    const result = await talkDirectoryExists(file)
    expect(result.exists).toBe(true)
    expect(result.isDirectory).toBe(false)
  })
})

describe('hasSlidesMd', () => {
  it('slides.md が無ければ false', async () => {
    const directory = path.join(state.temporaryRoot, 'd')
    mkdirSync(directory)
    expect(await hasSlidesMd(directory)).toBe(false)
  })

  it('slides.md があれば true', async () => {
    const directory = path.join(state.temporaryRoot, 'd2')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'slides.md'), '')
    expect(await hasSlidesMd(directory)).toBe(true)
  })
})
