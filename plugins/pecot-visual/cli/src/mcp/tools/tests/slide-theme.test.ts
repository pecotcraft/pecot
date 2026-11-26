// slide_theme ツールのハンドラ単体テスト。
//
// fixture テーマ（with-declaration）を node_modules/<name> に symlink した一時 talk-dir に対して
// ハンドラを直接呼び、応答の data を見る。子プロセスは起こさない。
// tools/list に載る形は、src/mcp/tests/contract.test.ts が pin する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下の fixture のみ */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { snapshotTree } from './tree-snapshot.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'
import { slideThemeDefaultDependencies } from '../../../commands/slidev-project/theme.js'
import type { ToolCallContext } from '../../server.js'
import { slideThemeTool } from '../slide-theme.js'
import { withOutputCheck } from './_output.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const THEME = path.join(CLI_ROOT, 'tests', 'fixtures', 'themes', 'with-declaration')
const THEME_NAME = 'slidev-theme-pecotv-test-declared'

const CALL: ToolCallContext = { signal: new AbortController().signal }

const temporaryRoot = useTemporaryDirectory('pecotv-test-slide-theme-', { resolveRealPath: true })

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

const tool = withOutputCheck(slideThemeTool(slideThemeDefaultDependencies))

function makeTalk(options: Readonly<{ link?: boolean, theme?: string }> = {}): string {
  const talk = temporaryRoot('talk')
  mkdirSync(talk, { recursive: true })
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${options.theme ?? THEME_NAME}\n---\n`)
  writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'talk', dependencies: { [THEME_NAME]: `file:${THEME}` } }))
  if (options.link !== false) {
    mkdirSync(path.join(talk, 'node_modules'))
    symlinkSync(THEME, path.join(talk, 'node_modules', THEME_NAME), 'dir')
  }
  return talk
}

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が object ではありません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredOf(result)
}

function sentenceOf(result: { readonly content?: unknown }): string {
  const content: unknown = result.content
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
}

describe('slide_theme の定義', () => {
  it('名前・description の 3 文・注釈を持つ', () => {
    expect(tool.name).toBe('slide_theme')
    expect(tool.config.description).toBe(
      'Returns the theme declaration referenced by a talk-dir and the list of layouts. '
      + 'The declaration covers fonts, font sizes, PPTX fonts and link colors, and lint rules. '
      + 'Skills use it to obtain theme values.',
    )
    expect(tool.config.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
  })
})

describe('slide_theme の成功', () => {
  it('theme・declaration・layouts・warnings と lint を返す', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-01')
    const talk = makeTalk()
    const result = await tool.handler({ dir: talk }, CALL)

    const structured = structuredOf(result)
    expect(structured).not.toHaveProperty('kind')
    expect(sentenceOf(result)).toBe(`slide_theme: ${THEME_NAME} (8 layouts)`)
    expect(result.isError).toBeUndefined()

    const data = dataOf(result)
    expect(data['event']).toBe('slide.theme.done')
    expect(data['theme']).toEqual({
      name: THEME_NAME,
      spec: `file:${THEME}`,
      declared: true,
      directory: path.join(talk, 'node_modules', THEME_NAME),
      linked: true,
    })
    expect(data['declaration']).toMatchObject({
      fonts: { eastAsian: 'Test Sans JP' },
      pptx: { eastAsianFont: 'Test Sans JP', linkColor: '0A7F3F' },
    })
    expect(data['layouts']).toEqual([
      expect.objectContaining({ layout: 'cover', category: 'text', filename: 'cover.yaml' }),
      expect.objectContaining({ layout: 'end', category: 'text', filename: 'end.yaml' }),
      expect.objectContaining({ layout: 'link', category: 'text', filename: 'link.yaml' }),
      expect.objectContaining({ layout: 'plain', category: 'text', filename: 'plain.yaml' }),
      expect.objectContaining({ layout: 'section', category: 'text', filename: 'section.yaml' }),
      expect.objectContaining({ layout: 'marked', category: 'figure', filename: 'marked.yaml' }),
      expect.objectContaining({ layout: 'panel', category: 'figure', filename: 'panel.yaml' }),
      expect.objectContaining({ layout: 'legacy-panel', category: 'figure', filename: 'legacy-panel.yaml', deprecated: true }),
    ])
    expect(data['lint']).toEqual({
      referencesDirectories: [
        path.join(talk, 'references'),
        path.join(talk, 'node_modules', THEME_NAME, 'references'),
      ],
      panels: { panel: { width: 400, height: 300 } },
      markerLayouts: ['marked'],
      rules: {
        'slidev-pages-lint/no-unknown-props': 'error',
        'slidev-pages-lint/no-missing-page': 'error',
        'text-constraints/max-chars': 'error',
      },
    })
    expect(data['warnings']).toEqual([])
    expect(data['categories']).toEqual([
      expect.objectContaining({ id: 'text' }),
      expect.objectContaining({ id: 'figure' }),
    ])
  })

  it('呼んでも talk-dir のファイルは変わらない', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-02')
    const talk = makeTalk()
    const before = snapshotTree(talk)

    const result = await tool.handler({ dir: talk }, CALL)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(snapshotTree(talk)).toEqual(before)
  })
})

describe('slide_theme の失敗', () => {
  it('テーマを張っていなければ theme-unlinked で、slide_sync の案内を含む', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-02')
    await verifies(context, 'PV-SLIDE-THEME-04')
    const talk = makeTalk({ link: false })
    const before = snapshotTree(talk)
    const result = await tool.handler({ dir: talk }, CALL)

    const structured = structuredOf(result)
    expect(structured).toHaveProperty('kind')
    expect(result.isError).toBe(true)
    const data = dataOf(result)
    expect(data['event']).toBe('slide.theme.error')
    expect(data['kind']).toBe('theme-unlinked')
    expect(data['detail']).toEqual(expect.stringContaining('node_modules_only'))
    expect(sentenceOf(result)).toEqual(expect.stringContaining('slide_sync'))
    // 張り直しと取得をしないので、node_modules は作られない。
    expect(snapshotTree(talk)).toEqual(before)
  })

  it('theme: none で宣言も無ければ theme-none で、slide_sync の theme を案内する', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-03')
    const talk = makeTalk({ theme: 'none' })
    const result = await tool.handler({ dir: talk }, CALL)

    expect(structuredOf(result)).toHaveProperty('kind')
    const data = dataOf(result)
    expect(data['kind']).toBe('theme-none')
    expect(data['detail']).toEqual(expect.stringContaining('slide_sync with theme: <theme-spec>'))
  })

  it('宣言の誤りは theme-<reason> で返す', async () => {
    const talk = makeTalk()
    const broken = temporaryRoot('broken-theme')
    mkdirSync(broken)
    writeFileSync(path.join(broken, 'package.json'), '{"name":"b"}')
    writeFileSync(path.join(broken, 'pecot-theme.json'), JSON.stringify({ schema: 1, lint: { rules: { 'no-such/rule': 'error' } } }))
    rmSync(path.join(talk, 'node_modules', THEME_NAME))
    symlinkSync(broken, path.join(talk, 'node_modules', THEME_NAME), 'dir')

    const data = dataOf(await tool.handler({ dir: talk }, CALL))
    expect(data['kind']).toBe('theme-unknown-rule')
  })

  it('宣言の形が決まった形でなければ theme-invalid-shape で返す', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-05')
    const talk = makeTalk()
    const broken = temporaryRoot('broken-shape-theme')
    mkdirSync(broken)
    writeFileSync(path.join(broken, 'package.json'), '{"name":"b"}')
    writeFileSync(path.join(broken, 'pecot-theme.json'), JSON.stringify({ schema: 1, slide: { width: -1, height: 1 } }))
    rmSync(path.join(talk, 'node_modules', THEME_NAME))
    symlinkSync(broken, path.join(talk, 'node_modules', THEME_NAME), 'dir')

    const result = await tool.handler({ dir: talk }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ event: 'slide.theme.error', kind: 'theme-invalid-shape' })
  })

  it('相対パスの dir は invalid-path で拒む', async () => {
    const result = await tool.handler({ dir: 'relative/talk' }, CALL)
    expect(structuredOf(result)['kind']).toBe('invalid-path')
  })
})
