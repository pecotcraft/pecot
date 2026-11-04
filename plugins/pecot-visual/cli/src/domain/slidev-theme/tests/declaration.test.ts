import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import { DEFAULT_THEME_DECLARATION } from '../defaults.js'
import { parseThemeDeclaration, readThemeDeclaration, ThemeDeclarationError } from '../declaration.js'
import type { ThemeFiles } from '../ports.js'

const THEMES = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'themes')
const WITH_DECLARATION = path.join(THEMES, 'with-declaration')
const WITHOUT_DECLARATION = path.join(THEMES, 'without-declaration')

function filesReturning(text: string | undefined): ThemeFiles {
  return {
    readText: () => Promise.resolve(text),
    listFiles: () => Promise.resolve([]),
  }
}

function thrownBy(run: () => unknown): ThemeDeclarationError {
  try {
    run()
  }
  catch (error: unknown) {
    if (error instanceof ThemeDeclarationError) return error
    throw error
  }
  throw new Error('ThemeDeclarationError が投げられませんでした')
}

async function thrownByAsync(run: () => Promise<unknown>): Promise<ThemeDeclarationError> {
  try {
    await run()
  }
  catch (error: unknown) {
    if (error instanceof ThemeDeclarationError) return error
    throw error
  }
  throw new Error('ThemeDeclarationError が投げられませんでした')
}

describe('readThemeDeclaration', () => {
  it('宣言のあるテーマの値をそのまま返し、警告は出さない', async () => {
    const { declaration, warnings } = await readThemeDeclaration(new NodeThemeFiles(), WITH_DECLARATION)
    expect(warnings).toEqual([])
    expect(declaration).toEqual({
      schema: 1,
      slide: { width: 960, height: 540 },
      fonts: { body: ['Test Sans'], heading: ['Test Sans'], eastAsian: 'Test Sans JP' },
      fontSizes: { heading: 18, headingSm: 15, body: 14, bodySm: 11, label: 10 },
      pptx: { eastAsianFont: 'Test Sans JP', linkColor: '0A7F3F' },
      lint: {
        rules: {
          'slidev-pages-lint/no-unknown-props': 'error',
          'slidev-pages-lint/no-missing-page': 'error',
          'text-constraints/max-chars': 'error',
        },
      },
      layouts: { references: 'references' },
      drawio: { panels: { panel: { width: 400, height: 300 } }, markerLayouts: ['marked'] },
    })
  })

  it('宣言の無いテーマは、宣言が無い旨の警告を 1 件出し、既定値で続ける', async () => {
    const { declaration, warnings } = await readThemeDeclaration(new NodeThemeFiles(), WITHOUT_DECLARATION)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('宣言が無い')
    expect(warnings[0]).toContain(WITHOUT_DECLARATION)
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('JSON として読めない宣言は invalid-shape で止める', async () => {
    await expect(readThemeDeclaration(filesReturning('{ not json'), '/theme')).rejects.toMatchObject({
      name: 'ThemeDeclarationError',
      reason: 'invalid-shape',
    })
    const error = await thrownByAsync(() => readThemeDeclaration(filesReturning('{ not json'), '/theme'))
    expect(error.message).toContain('contracts/theme-declaration.md')
  })

  it('形の誤りは invalid-shape で止め、誤りの項目名を含める', async () => {
    const text = JSON.stringify({ schema: 1, fontSizes: { heading: 'big' } })
    const error = await thrownByAsync(() => readThemeDeclaration(filesReturning(text), '/theme'))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('fontSizes.heading')
    expect(error.message).toContain('contracts/theme-declaration.md の「`pecot-theme.json`」の節')
  })
})

describe('parseThemeDeclaration', () => {
  it('既定値の値は R6 のとおり', () => {
    expect(DEFAULT_THEME_DECLARATION).toEqual({
      schema: 1,
      slide: { width: 960, height: 540 },
      fonts: { body: ['sans-serif'], heading: ['sans-serif'] },
      fontSizes: { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 },
      pptx: {},
      lint: {
        rules: {
          'slidev-pages-lint/one-slide-per-file': 'error',
          'slidev-pages-lint/no-content-before-frontmatter': 'error',
          'slidev-pages-lint/require-slides-entry': 'error',
          'slidev-pages-lint/no-triple-hyphen-in-frontmatter': 'error',
          'slidev-pages-lint/no-numeric-filename-prefix': 'error',
          'slidev-pages-lint/no-numeric-asset-prefix': 'error',
          'slidev-pages-lint/no-missing-page': 'error',
          'text-constraints/textlint': 'error',
          'text-constraints/textlint-body': 'error',
        },
      },
      layouts: { references: 'references' },
      drawio: { panels: {}, markerLayouts: [] },
    })
  })

  it('schema だけの宣言は、すべて既定値で埋める', () => {
    const { declaration, warnings } = parseThemeDeclaration({ schema: 1 })
    expect(warnings).toEqual([])
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('項目の一部だけを省いた場合、省いた分だけ既定値で埋める', () => {
    const { declaration } = parseThemeDeclaration({
      schema: 1,
      fontSizes: { heading: 20 },
      fonts: { body: ['Foo'] },
      drawio: { markerLayouts: ['x'] },
    })
    expect(declaration.fontSizes).toEqual({ heading: 20, headingSm: 13, body: 12, bodySm: 10, label: 9 })
    expect(declaration.fonts).toEqual({ body: ['Foo'], heading: ['sans-serif'] })
    expect(declaration.drawio).toEqual({ panels: {}, markerLayouts: ['x'] })
  })

  it('知らない schema は警告し、宣言の中身を使わず既定値で続ける', () => {
    const { declaration, warnings } = parseThemeDeclaration({ schema: 2, fontSizes: { heading: 99 } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('schema')
    expect(warnings[0]).toContain('2')
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('schema が無い宣言は invalid-shape', () => {
    const error = thrownBy(() => parseThemeDeclaration({ slide: { width: 1, height: 1 } }))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('schema')
  })

  it('オブジェクトでない宣言は invalid-shape', () => {
    expect(thrownBy(() => parseThemeDeclaration([])).reason).toBe('invalid-shape')
    expect(thrownBy(() => parseThemeDeclaration([])).message).toContain('contracts/theme-declaration.md')
    expect(thrownBy(() => parseThemeDeclaration('x')).reason).toBe('invalid-shape')
  })

  it('知らない規則名は unknown-rule で止め、規則名を含める', () => {
    const error = thrownBy(() => parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'slidev-pages-lint/no-such-rule': 'error' } },
    }))
    expect(error.reason).toBe('unknown-rule')
    expect(error.message).toContain('slidev-pages-lint/no-such-rule')
    expect(error.message).toContain('contracts/theme-declaration.md の「`pecot-theme.json`」の節の「lint.rules」の項')
  })

  it('既知の規則名と重さ（error / warn / off）を受ける', () => {
    const { declaration } = parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'text-constraints/max-chars': 'warn', 'slidev-pages-lint/no-scaled-drawio': 'off' } },
    })
    expect(declaration.lint.rules).toEqual({
      'text-constraints/max-chars': 'warn',
      'slidev-pages-lint/no-scaled-drawio': 'off',
    })
  })

  it('規則の重さが error / warn / off でなければ invalid-shape', () => {
    const error = thrownBy(() => parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'text-constraints/max-chars': 'loud' } },
    }))
    expect(error.reason).toBe('invalid-shape')
  })

  it('linkColor は 6 桁の 16 進だけ受ける', () => {
    expect(thrownBy(() => parseThemeDeclaration({ schema: 1, pptx: { linkColor: '#fff' } })).reason).toBe('invalid-shape')
    expect(parseThemeDeclaration({ schema: 1, pptx: { linkColor: 'a1B2c3' } }).declaration.pptx.linkColor).toBe('a1B2c3')
  })

  it('寸法が正の数でなければ invalid-shape', () => {
    const error = thrownBy(() => parseThemeDeclaration({ schema: 1, slide: { width: 0, height: 540 } }))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('slide.width')
  })
})
