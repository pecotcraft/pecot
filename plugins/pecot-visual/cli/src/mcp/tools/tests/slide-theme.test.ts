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
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'
import { slideThemeDefaultDependencies } from '../../../commands/slidev-project/theme.js'
import type { ToolCallContext } from '../../server.js'
import { slideThemeTool } from '../slide-theme.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const THEME = path.join(CLI_ROOT, 'tests', 'fixtures', 'themes', 'with-declaration')
const THEME_NAME = 'slidev-theme-pecotv-test-declared'

const CALL: ToolCallContext = { signal: new AbortController().signal }

const temporaryRoot = useTemporaryDirectory('pecotv-test-slide-theme-', { resolveRealPath: true })

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

const tool = slideThemeTool(slideThemeDefaultDependencies)

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
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が object ではありません')
  return data
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
  it('theme・declaration・layouts・warnings と lint を返す', async () => {
    const talk = makeTalk()
    const result = await tool.handler({ dir: talk }, CALL)

    const structured = structuredOf(result)
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([])
    expect(structured['message']).toBe(`slide theme: ${THEME_NAME} (8 layouts)`)
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
  })
})

describe('slide_theme の失敗', () => {
  it('テーマを張っていなければ theme-unlinked で、slide_sync の案内を含む', async () => {
    const talk = makeTalk({ link: false })
    const result = await tool.handler({ dir: talk }, CALL)

    const structured = structuredOf(result)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(result.isError).toBe(true)
    const data = dataOf(result)
    expect(data['event']).toBe('slide.theme.error')
    expect(data['reason']).toBe('theme-unlinked')
    expect(data['detail']).toEqual(expect.stringContaining('--node-modules-only'))
  })

  it('theme: none で宣言も無ければ theme-none で、slide sync --theme を案内する', async () => {
    const talk = makeTalk({ theme: 'none' })
    const result = await tool.handler({ dir: talk }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    const data = dataOf(result)
    expect(data['reason']).toBe('theme-none')
    expect(data['detail']).toEqual(expect.stringContaining('slide sync --theme <theme-spec>'))
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
    expect(data['reason']).toBe('theme-unknown-rule')
  })

  it('相対パスの dir は usage error（exit 2）で拒む', async () => {
    const result = await tool.handler({ dir: 'relative/talk' }, CALL)
    expect(structuredOf(result)['ok']).toBe(false)
    expect(structuredOf(result)['exitCode']).toBe(2)
  })
})
