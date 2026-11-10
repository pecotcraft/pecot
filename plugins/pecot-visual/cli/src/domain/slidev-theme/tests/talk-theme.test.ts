/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import { ThemeResolveError, classifyTalkTheme, findTalkThemeDependency, resolveTalkTheme } from '../talk-theme.js'

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
  it('theme: がパッケージ名そのままなら、dependencies の同名を使う', async () => {
    writeTalk('theme: slidev-theme-acme', { 'slidev-theme-acme': 'git+https://example.com/o/acme.git#v1.0.0' })
    const root = linkRoot('slidev-theme-acme')
    expect(await resolveTalkTheme(new NodeThemeFiles(), state.talk)).toEqual({
      name: 'slidev-theme-acme',
      spec: 'git+https://example.com/o/acme.git#v1.0.0',
      directory: root,
      linked: true,
    })
  })

  it('スコープ付きの名前もそのまま引く', async () => {
    writeTalk('theme: \'@acme/slidev-theme-sample\'', { '@acme/slidev-theme-sample': 'file:../tpl' })
    const root = linkRoot('@acme/slidev-theme-sample')
    expect(await resolveTalkTheme(new NodeThemeFiles(), state.talk)).toEqual({
      name: '@acme/slidev-theme-sample',
      spec: 'file:../tpl',
      directory: root,
      linked: true,
    })
  })

  it('短い名前は @slidev/theme-<x> を最初に引く', async () => {
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

  it('次に slidev-theme-<x>、最後に <x> を引く', async () => {
    writeTalk('theme: acme', { 'slidev-theme-acme': 'file:../b', 'acme': 'file:../c' })
    linkRoot('slidev-theme-acme')
    expect(await resolvedName()).toBe('slidev-theme-acme')

    writeTalk('theme: acme', { acme: 'file:../c' })
    linkRoot('acme')
    expect(await resolvedName()).toBe('acme')
  })
})

describe('resolveTalkTheme の上位の node_modules', () => {
  it('talk-dir 直下に無ければ、上位の node_modules/<name> を root にする（linked: false）', async () => {
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

  it('talk-dir 直下と上位の両方にあれば、直下を使う（linked: true）', async () => {
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

  it('どの node_modules にも無ければ theme-unlinked', async () => {
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
  it('接頭辞付きの名前は候補 1 つ。存在しない名前を並べない', async () => {
    writeTalk('theme: slidev-theme-x', { other: '1' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('searched names: slidev-theme-x)')
    expect(error.message).not.toContain('@slidev/theme-slidev-theme-x')
    expect(error.message).not.toContain('slidev-theme-slidev-theme-x')
  })

  it('@ 始まりの名前も候補 1 つ', async () => {
    writeTalk('theme: \'@pecot/missing\'', { other: '1' })
    const error = await rejection()
    expect(error.message).toContain('searched names: @pecot/missing)')
  })

  it('短い名前は 3 つの候補を順に列挙する', async () => {
    writeTalk('theme: x', { other: '1' })
    const error = await rejection()
    expect(error.message).toContain('searched names: @slidev/theme-x, slidev-theme-x, x)')
  })

  it.each(['./theme', '../theme', '/abs/theme', '@/theme', 'dir/theme'])(
    'パス形式の theme: %s は theme-none で、パッケージ名として探さない',
    async (theme) => {
      writeTalk(`theme: '${theme}'`, { [theme]: 'file:../x' })
      const error = await rejection()
      expect(error.reason).toBe('theme-none')
      expect(error.message).toContain('is a path')
      expect(error.message).toContain('slide sync --theme <theme-spec>')
      expect(error.message).not.toContain('add the theme to dependencies')
    },
  )

  it('スコープ付きの名前（@a/b）はパス形式ではない', async () => {
    writeTalk('theme: \'@pecot/theme\'', { '@pecot/theme': 'file:../x' })
    linkRoot('@pecot/theme')
    const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
    expect(result.name).toBe('@pecot/theme')
  })
})

describe('resolveTalkTheme の失敗', () => {
  it('テーマ root が無ければ theme-unlinked で、node-modules-only の同期を案内する', async () => {
    writeTalk('theme: slidev-theme-acme', { 'slidev-theme-acme': 'file:../acme' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain(`slide sync --dir ${state.talk} --node-modules-only`)
    // MCP から読む場合の手順も、同じ文言に含める
    expect(error.message).toContain(`slide_sync with dir: ${state.talk}, node_modules_only: true`)
    expect(error.message).toContain(path.join(state.talk, 'node_modules', 'slidev-theme-acme'))
  })

  it('theme: の名前が dependencies に無ければ theme-unlinked で、dependencies の確認を案内する', async () => {
    writeTalk('theme: acme', { other: 'file:../other' })
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('dependencies')
    expect(error.message).toContain('acme')
  })

  it('package.json が無ければ theme-unlinked', async () => {
    writeTalk('theme: acme', undefined)
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('package.json')
  })

  it('package.json が JSON でなければ theme-unlinked で、読めない旨を示す', async () => {
    writeTalk('theme: acme', undefined)
    writeFileSync(path.join(state.talk, 'package.json'), '{ broken')
    const error = await rejection()
    expect(error.reason).toBe('theme-unlinked')
    expect(error.message).toContain('JSON')
  })

  it('theme: none で pecot-theme.json も無ければ theme-none で、slide sync --theme を案内する', async () => {
    writeTalk('theme: none', { 'slidev-theme-acme': 'file:../acme' })
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
    expect(error.message).toContain('slide sync --theme <theme-spec>')
  })

  it('theme: が無い slides.md も theme-none', async () => {
    writeTalk('title: 無題', {})
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })

  it('slides.md が無い talk-dir も theme-none', async () => {
    writeTalk(undefined, {})
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })

  it('frontmatter が不正な slides.md も theme-none として止める', async () => {
    writeFileSync(path.join(state.talk, 'slides.md'), '---\ntheme: [unclosed\n---\n')
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
  })
})

describe('resolveTalkTheme: pecot-theme.json を持つ dir', () => {
  it('theme: none で dir 自身に pecot-theme.json があっても、テーマとして読まず theme-none で止める', async () => {
    writeTalk('theme: none', { 'unrelated-dependency': 'file:../x' })
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{"schema":1}')
    const error = await rejection()
    expect(error.reason).toBe('theme-none')
    expect(error.message, 'テーマの dir だと伝えていない').toContain('it is a theme dir')
    expect(error.message, '移行の案内を出している').not.toContain('slide sync --theme')
  })

  it('theme: が名前付きなら、pecot-theme.json が talk-dir にあっても node_modules のテーマを使う', async () => {
    writeTalk('theme: acme', { acme: 'file:../acme' })
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{"schema":1}')
    const root = linkRoot('acme')
    const result = await resolveTalkTheme(new NodeThemeFiles(), state.talk)
    expect(result.directory).toBe(root)
  })
})

describe('findTalkThemeDependency', () => {
  it('node_modules に張られていなくても、dependencies から名前と spec を返す', async () => {
    writeTalk('theme: sample', { 'slidev-theme-sample': 'file:../sample' })
    expect(await findTalkThemeDependency(new NodeThemeFiles(), state.talk)).toStrictEqual({
      name: 'slidev-theme-sample',
      spec: 'file:../sample',
    })
  })

  it('theme: none と未指定は undefined', async () => {
    writeTalk('theme: none', {})
    expect(await findTalkThemeDependency(new NodeThemeFiles(), state.talk)).toBeUndefined()
  })

  it('theme: に当たるパッケージが dependencies に無ければ theme-unlinked', async () => {
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
  it('theme: がパッケージ名で dependencies にあれば migrated', async () => {
    writeTalk('theme: sample', { 'slidev-theme-sample': 'file:../sample' })
    expect(await classified()).toBe('migrated')
  })

  it.each([['theme: none'], ['title: A'], ['theme: ./theme'], ['theme: ../theme'], ['theme: /abs/theme'], ['theme: local/theme']])(
    'pecot-theme.json が無く、frontmatter が %s なら legacy',
    async (frontmatter) => {
      writeTalk(frontmatter, {})
      expect(await classified()).toBe('legacy')
    },
  )

  it('package.json が無い移行前の talk-dir も legacy', async () => {
    writeTalk('theme: none', undefined)
    expect(await classified()).toBe('legacy')
  })

  it('theme: none で root に pecot-theme.json があれば theme-root', async () => {
    writeTalk('theme: none', {})
    writeFileSync(path.join(state.talk, 'pecot-theme.json'), '{}')
    expect(await classified()).toBe('theme-root')
  })

  it('theme: が依存に無ければ theme-unlinked で止める', async () => {
    writeTalk('theme: sample', { other: '1.0.0' })
    await expect(classified()).rejects.toMatchObject({ reason: 'theme-unlinked' })
  })
})
