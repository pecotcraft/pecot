/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import { ThemeResolveError, classifyTalkTheme, findTalkThemeDependency, resolveTalkTheme } from '../talk-theme.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const state = { talk: '' }

beforeEach(() => {
  state.talk = mkdtempSync(path.join(tmpdir(), 'pecotv-talk-theme-'))
})

afterEach(() => {
  rmSync(state.talk, { recursive: true, force: true })
})

function writeTalk(slidesFrontmatter: string | undefined, dependencies: Readonly<Record<string, string>> | undefined): void {
  if (slidesFrontmatter !== undefined) {
    writeFileSync(path.join(state.talk, 'slides.md'), `---\n${slidesFrontmatter}\n---\n\n# 表紙\n`)
  }
  if (dependencies !== undefined) {
    writeFileSync(path.join(state.talk, 'package.json'), JSON.stringify({ name: 'talk', dependencies }))
  }
}

function linkRoot(name: string): string {
  const root = path.join(state.talk, 'node_modules', name)
  mkdirSync(root, { recursive: true })
  // テーマ root の実在は package.json が読めるかで見る（npm パッケージは必ず持つ）。
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }))
  return root
}

async function resolvedName(): Promise<string> {
  const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
  return result.name
}

async function rejection(): Promise<ThemeResolveError> {
  try {
    await resolveTalkTheme(new NodeThemeFiles(), state.talk)
  }
  catch (error: unknown) {
    if (error instanceof ThemeResolveError) return error
    throw error
  }
  throw new Error('ThemeResolveError が投げられませんでした')
}

describe('resolveTalkTheme の名前の解決', () => {
  it('theme: がパッケージ名そのままの場合は、dependencies の同じ名前を使う', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`dependencies` に同じ名前がある場合に、名前・spec・テーマの dir が返り、`linked` が `true` になることを確認します。')
    writeTalk('theme: slidev-theme-acme', { 'slidev-theme-acme': 'git+https://example.com/o/acme.git#v1.0.0' })
    const root = linkRoot('slidev-theme-acme')
    expect(await resolveTalkTheme(new NodeThemeFiles(), state.talk)).toEqual({
      name: 'slidev-theme-acme',
      spec: 'git+https://example.com/o/acme.git#v1.0.0',
      directory: root,
      linked: true,
    })
  })

  it('スコープ付きのテーマ名も、そのまま dependencies から探す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`@acme/slidev-theme-sample` のようにスコープ付きの名前の場合に、同じ名前の依存が見つかり、`linked` が `true` になることを確認します。')
    writeTalk('theme: \'@acme/slidev-theme-sample\'', { '@acme/slidev-theme-sample': 'file:../tpl' })
    const root = linkRoot('@acme/slidev-theme-sample')
    expect(await resolveTalkTheme(new NodeThemeFiles(), state.talk)).toEqual({
      name: '@acme/slidev-theme-sample',
      spec: 'file:../tpl',
      directory: root,
      linked: true,
    })
  })

  it('短い名前は、@slidev/theme-<x> を最初に探す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。3 つの候補名がすべて依存にある場合は、`@slidev/theme-acme` が選ばれることを確認します。')
    writeTalk('theme: acme', {
      '@slidev/theme-acme': 'file:../a',
      'slidev-theme-acme': 'file:../b',
      'acme': 'file:../c',
    })
    linkRoot('@slidev/theme-acme')
    const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
    expect(result.name).toBe('@slidev/theme-acme')
    expect(result.spec).toBe('file:../a')
  })

  it('短い名前は、@slidev/theme-<x> の次に slidev-theme-<x>、最後に <x> を探す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。先頭の候補が存在しない場合に `slidev-theme-acme` が選ばれ、それも存在しない場合に `acme` が選ばれることを確認します。')
    writeTalk('theme: acme', { 'slidev-theme-acme': 'file:../b', 'acme': 'file:../c' })
    linkRoot('slidev-theme-acme')
    expect(await resolvedName()).toBe('slidev-theme-acme')

    writeTalk('theme: acme', { acme: 'file:../c' })
    linkRoot('acme')
    expect(await resolvedName()).toBe('acme')
  })
})

describe('resolveTalkTheme の上位の node_modules', () => {
  it('talk-dir の直下に存在しない場合は、上位の node_modules/<name> をテーマの root にする（linked: false）', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。テーマが上位の `node_modules` だけにある場合に、その dir が root になり、`linked` が `false` になることを確認します。')
    const workspace = state.talk
    const talk = path.join(workspace, 'packages', 'deck')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: default\n---\n')
    writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'deck', dependencies: { '@slidev/theme-default': '*' } }))
    const root = path.join(workspace, 'node_modules', '@slidev', 'theme-default')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), '{"name":"@slidev/theme-default"}')

    const result = await resolveTalkTheme(new NodeThemeFiles(), talk)
    expect(result).toEqual({ name: '@slidev/theme-default', spec: '*', directory: root, linked: false })
  })

  it('talk-dir の直下と上位の両方に存在する場合は、直下を使う（linked: true）', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。同じテーマが両方の `node_modules` にある場合は、talk-dir 直下のものが選ばれ、`linked` が `true` になることを確認します。')
    const talk = path.join(state.talk, 'deck')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: acme\n---\n')
    writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'deck', dependencies: { acme: 'file:../acme' } }))
    for (const base of [state.talk, talk]) {
      mkdirSync(path.join(base, 'node_modules', 'acme'), { recursive: true })
      writeFileSync(path.join(base, 'node_modules', 'acme', 'package.json'), '{"name":"acme"}')
    }
    const result = await resolveTalkTheme(new NodeThemeFiles(), talk)
    expect(result.directory).toBe(path.join(talk, 'node_modules', 'acme'))
    expect(result.linked).toBe(true)
  })

  it('どの node_modules にも存在しない場合は、理由 theme-unlinked のエラーを返す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。どの `node_modules` にもテーマが存在しない場合に、理由 `theme-unlinked` のエラーが発生し、探した場所が含まれることを確認します。')
    const talk = path.join(state.talk, 'deck')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: no-such-theme-anywhere-1344\n---\n')
    writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'deck', dependencies: { 'no-such-theme-anywhere-1344': '*' } }))
    state.talk = talk
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('any parent node_modules')
  })
})

describe('resolveTalkTheme の候補名とパス形式', () => {
  it('接頭辞付きの名前は、候補を 1 つだけにし、存在しない名前を並べない', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: slidev-theme-x` の場合に、エラーのメッセージに探した名前が `slidev-theme-x` だけ載り、接頭辞を重ねた名前が含まれないことを確認します。')
    writeTalk('theme: slidev-theme-x', { other: '1' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('searched names: slidev-theme-x)')
    expect(error.message).not.toContain('@slidev/theme-slidev-theme-x')
    expect(error.message).not.toContain('slidev-theme-slidev-theme-x')
  })

  it('@ で始まる名前も、候補を 1 つだけにする', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: \'@pecot/missing\'` の場合に、エラーのメッセージに探した名前が `@pecot/missing` だけ載ることを確認します。')
    writeTalk('theme: \'@pecot/missing\'', { other: '1' })
    const error = await rejection()
    expect(error.message).toContain('searched names: @pecot/missing)')
  })

  it('短い名前の場合は、3 つの候補を順にメッセージへ載せる', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: x` の場合に、エラーのメッセージに探した名前が `@slidev/theme-x, slidev-theme-x, x` の順で載ることを確認します。')
    writeTalk('theme: x', { other: '1' })
    const error = await rejection()
    expect(error.message).toContain('searched names: @slidev/theme-x, slidev-theme-x, x)')
  })

  it.each(['./theme', '../theme', '/abs/theme', '@/theme', 'dir/theme'])(
    'パス形式の theme: %s は、パッケージ名として探さず、理由 theme-none のエラーを返す',
    async (theme) => {
      await explains(`talk-dir のテーマを解決する \`resolveTalkTheme\` のテストです。\`theme: ${theme}\` のようにパス形式の場合に、理由 \`theme-none\` のエラーが発生し、\`slide sync --theme\` の案内が含まれることを確認します。`)
      writeTalk(`theme: '${theme}'`, { [theme]: 'file:../x' })
      const error = await rejection()
      expect(error.reason).toBe('theme-none')
      expect(error.message).toContain('is a path')
      expect(error.message).toContain('slide_sync with theme: <theme-spec>')
      expect(error.message).not.toContain('add the theme to dependencies')
    },
  )

  it('スコープ付きの名前（@a/b）は、パス形式として扱わない', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: \'@pecot/theme\'` の場合に、パス形式と判定されず、パッケージ名 `@pecot/theme` として解決されることを確認します。')
    writeTalk('theme: \'@pecot/theme\'', { '@pecot/theme': 'file:../x' })
    linkRoot('@pecot/theme')
    const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
    expect(result.name).toBe('@pecot/theme')
  })
})

describe('resolveTalkTheme の失敗', () => {
  it('テーマの root が存在しない場合は、理由 theme-unlinked のエラーで、node-modules-only の同期を案内する', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`node_modules` にテーマが存在しない場合に、理由 `theme-unlinked` のエラーが発生し、`slide sync` の案内が含まれることを確認します。')
    writeTalk('theme: slidev-theme-acme', { 'slidev-theme-acme': 'file:../acme' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain(`slide_sync with dir: ${state.talk}, node_modules_only: true`)
    expect(error.message).toContain(path.join(state.talk, 'node_modules', 'slidev-theme-acme'))
  })

  it('theme: の名前が dependencies に存在しない場合は、理由 theme-unlinked のエラーで、dependencies の確認を案内する', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`dependencies` に `acme` が存在しない場合は、理由 `theme-unlinked` のエラーが発生し、`dependencies` の確認を促すことを確認します。')
    writeTalk('theme: acme', { other: 'file:../other' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('dependencies')
    expect(error.message).toContain('acme')
  })

  it('package.json が存在しない場合は、理由 theme-unlinked のエラーを返す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`package.json` が存在しない場合に、理由 `theme-unlinked` のエラーが発生し、メッセージに `package.json` が含まれることを確認します。')
    writeTalk('theme: acme', undefined)
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('package.json')
  })

  it('package.json が JSON として不正な場合は、理由 theme-unlinked のエラーで、読み込めない旨を示す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`package.json` が `{ broken` のように不正な場合に、理由 `theme-unlinked` のエラーが発生し、メッセージに `JSON` が含まれることを確認します。')
    writeTalk('theme: acme', undefined)
    writeFileSync(path.join(state.talk, 'package.json'), '{ broken')
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('JSON')
  })

  it('theme: none で pecot-theme.json も存在しない場合は、理由 theme-none のエラーで、slide_sync の theme を案内する', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: none` で `pecot-theme.json` も存在しない場合は、理由 `theme-none` のエラーが発生し、`slide_sync` の `theme` の案内が含まれることを確認します。')
    writeTalk('theme: none', { 'slidev-theme-acme': 'file:../acme' })
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
    expect(error.message).toContain('slide_sync with theme: <theme-spec>')
  })

  it('slides.md に theme: が存在しない場合も、理由 theme-none のエラーを返す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。frontmatter に `theme:` が存在しない場合は、理由 `theme-none` のエラーが発生することを確認します。')
    writeTalk('title: 無題', {})
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })

  it('slides.md が存在しない talk-dir も、理由 theme-none のエラーを返す', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`slides.md` が存在しない場合は、理由 `theme-none` のエラーが発生することを確認します。')
    writeTalk(undefined, {})
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })

  it('slides.md の frontmatter が不正な場合も、理由 theme-none のエラーで止める', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`slides.md` の frontmatter が `theme: [unclosed` のように YAML として不正な場合に、理由 `theme-none` のエラーが発生することを確認します。')
    writeFileSync(path.join(state.talk, 'slides.md'), '---\ntheme: [unclosed\n---\n')
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })
})

describe('resolveTalkTheme: pecot-theme.json を持つ dir', () => {
  it('theme: none の dir 自身に pecot-theme.json が存在しても、テーマとして読まず、理由 theme-none のエラーで止める', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: none` の dir に `pecot-theme.json` がある場合は、理由 `theme-none` のエラーが発生し、テーマの dir だと伝える文が含まれることを確認します。')
    writeTalk('theme: none', { 'unrelated-dependency': 'file:../x' })
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{"schema":1}')
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
    expect(error.message, 'テーマの dir だと伝えていない').toContain('it is a theme dir')
    expect(error.message, '移行の案内を出している').not.toContain('slide_sync with theme')
  })

  it('theme: が名前付きの場合は、talk-dir に pecot-theme.json が存在しても、node_modules のテーマを使う', async () => {
    await explains('talk-dir のテーマを解決する `resolveTalkTheme` のテストです。`theme: acme` の talk-dir に `pecot-theme.json` がある場合でも、`node_modules` の `acme` が root として選ばれることを確認します。')
    writeTalk('theme: acme', { acme: 'file:../acme' })
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{"schema":1}')
    const root = linkRoot('acme')
    const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
    expect(result.directory).toBe(root)
  })
})

describe('findTalkThemeDependency', () => {
  it('node_modules にテーマが存在しなくても、dependencies から名前と spec を返す', async () => {
    await explains('talk-dir の依存からテーマを探す `findTalkThemeDependency` のテストです。`theme: sample` で `node_modules` が存在しない場合でも、`slidev-theme-sample` と `file:../sample` が返ることを確認します。')
    writeTalk('theme: sample', { 'slidev-theme-sample': 'file:../sample' })
    expect(await findTalkThemeDependency(new NodeThemeFiles(), state.talk)).toStrictEqual({
      name: 'slidev-theme-sample',
      spec: 'file:../sample',
    })
  })

  it('theme: none と未指定の場合は、undefined を返す', async () => {
    await explains('talk-dir の依存からテーマを探す `findTalkThemeDependency` のテストです。`theme: none` の場合に、探すべき依存がなく `undefined` を返すことを確認します。')
    writeTalk('theme: none', {})
    expect(await findTalkThemeDependency(new NodeThemeFiles(), state.talk)).toBeUndefined()
  })

  it('theme: に対応するパッケージが dependencies に存在しない場合は、理由 theme-unlinked のエラーを返す', async () => {
    await explains('talk-dir の依存からテーマを探す `findTalkThemeDependency` のテストです。`theme: sample` で `dependencies` に対応する名前が存在しない場合に、理由 `theme-unlinked` のエラーが発生することを確認します。')
    writeTalk('theme: sample', { other: '1.0.0' })
    await expect(findTalkThemeDependency(new NodeThemeFiles(), state.talk)).rejects.toMatchObject({
      reason: 'theme-unlinked',
    })
  })
})

async function classified(): Promise<string> {
  return await classifyTalkTheme(new NodeThemeFiles(), state.talk)
}

describe('classifyTalkTheme', () => {
  it('theme: がパッケージ名で dependencies に存在する場合は、migrated と判定する', async () => {
    await explains('talk-dir の種類を判定する `classifyTalkTheme` のテストです。`theme: sample` で `dependencies` に `slidev-theme-sample` がある場合に、`migrated`（移行済み）を返すことを確認します。')
    writeTalk('theme: sample', { 'slidev-theme-sample': 'file:../sample' })
    expect(await classified()).toBe('migrated')
  })

  it.each([['theme: none'], ['title: A'], ['theme: ./theme'], ['theme: ../theme'], ['theme: /abs/theme'], ['theme: local/theme']])(
    'pecot-theme.json が存在せず、frontmatter が「%s」の場合は、legacy と判定する',
    async (frontmatter) => {
      await explains(`talk-dir の種類を判定する \`classifyTalkTheme\` のテストです。\`pecot-theme.json\` が存在せず、frontmatter が \`${frontmatter}\` の場合に、\`legacy\`（移行前）を返すことを確認します。`)
      writeTalk(frontmatter, {})
      expect(await classified()).toBe('legacy')
    },
  )

  it('package.json が存在しない移行前の talk-dir も、legacy と判定する', async () => {
    await explains('talk-dir の種類を判定する `classifyTalkTheme` のテストです。`theme: none` で `package.json` が存在しない場合に、`legacy`（移行前）を返すことを確認します。')
    writeTalk('theme: none', undefined)
    expect(await classified()).toBe('legacy')
  })

  it('theme: none で root に pecot-theme.json が存在する場合は、theme-root と判定する', async () => {
    await explains('talk-dir の種類を判定する `classifyTalkTheme` のテストです。`theme: none` の dir に `pecot-theme.json` がある場合に、テーマ自身の dir として `theme-root` を返すことを確認します。')
    writeTalk('theme: none', {})
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{}')
    expect(await classified()).toBe('theme-root')
  })

  it('theme: が依存に存在しない場合は、理由 theme-unlinked のエラーで止める', async () => {
    await explains('talk-dir の種類を判定する `classifyTalkTheme` のテストです。`theme: sample` で `dependencies` に対応する名前が存在しない場合に、理由 `theme-unlinked` のエラーが発生することを確認します。')
    writeTalk('theme: sample', { other: '1.0.0' })
    await expect(classified()).rejects.toMatchObject({ reason: 'theme-unlinked' })
  })
})
