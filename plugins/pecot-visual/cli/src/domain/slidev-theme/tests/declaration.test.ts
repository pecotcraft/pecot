import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import { DEFAULT_THEME_DECLARATION } from '../defaults.js'
import { parseThemeDeclaration, readThemeDeclaration, ThemeDeclarationError } from '../declaration.js'
import type { ThemeFiles } from '../ports.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('宣言が存在するテーマでは、宣言の値をそのまま返し、警告を表示しない', async () => {
    await explains('テーマの宣言ファイルを読み込む `readThemeDeclaration` のテストです。`pecot-theme.json` を持つテーマの場合に、スライドの寸法・フォント・lint の規則などが宣言のとおりに返り、警告が空であることを確認します。')
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

  it('宣言が存在しないテーマでは、宣言が存在しない旨の警告を 1 件表示し、既定値を返す', async () => {
    await explains('テーマの宣言ファイルを読み込む `readThemeDeclaration` のテストです。`pecot-theme.json` が存在しない場合に、`has no pecot-theme.json declaration` を含む警告が 1 件返り、宣言は既定値になることを確認します。')
    const { declaration, warnings } = await readThemeDeclaration(new NodeThemeFiles(), WITHOUT_DECLARATION)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('has no pecot-theme.json declaration')
    expect(warnings[0]).toContain(WITHOUT_DECLARATION)
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('JSON として解析できない宣言は、理由 invalid-shape のエラーで処理を止める', async () => {
    await explains('テーマの宣言ファイルを読み込む `readThemeDeclaration` のテストです。`{ not json` を渡した場合に、理由 `invalid-shape` のエラーが発生し、メッセージに `contracts/theme-declaration.md` が含まれることを確認します。')
    await expect(readThemeDeclaration(filesReturning('{ not json'), '/theme')).rejects.toMatchObject({
      name: 'ThemeDeclarationError',
      reason: 'invalid-shape',
    })
    const error = await thrownByAsync(() => readThemeDeclaration(filesReturning('{ not json'), '/theme'))
    expect(error.message).toContain('contracts/theme-declaration.md')
  })

  it('宣言の形に誤りがある場合は、理由 invalid-shape のエラーに、誤りのある項目名を含める', async () => {
    await explains('テーマの宣言ファイルを読み込む `readThemeDeclaration` のテストです。`fontSizes.heading` に数値でない値を指定した場合に、理由 `invalid-shape` のエラーが発生し、メッセージにその項目名と仕様の参照先が含まれることを確認します。')
    const text = JSON.stringify({ schema: 1, fontSizes: { heading: 'big' } })
    const error = await thrownByAsync(() => readThemeDeclaration(filesReturning(text), '/theme'))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('fontSizes.heading')
    expect(error.message).toContain('the `pecot-theme.json` section of contracts/theme-declaration.md')
  })
})

describe('parseThemeDeclaration', () => {
  it('既定の宣言は、仕様で定めた値と一致する', async () => {
    await explains('既定の宣言 `DEFAULT_THEME_DECLARATION` のテストです。スライドの寸法・フォント・フォントサイズ・lint の規則・レイアウトの参照先・drawio の設定が、仕様で定めた既定値と一致することを確認します。')
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

  it('schema だけを指定した宣言は、ほかの項目をすべて既定値にする', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`schema: 1` だけを渡した場合に、警告が空で、結果が既定の宣言と一致することを確認します。')
    const { declaration, warnings } = parseThemeDeclaration({ schema: 1 })
    expect(warnings).toEqual([])
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('項目の一部を省略した場合は、省略した項目だけを既定値にする', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`fontSizes`・`fonts`・`drawio` の一部だけを指定した場合に、指定した値は残り、省略した値だけが既定値になることを確認します。')
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

  it('未対応の schema の番号を指定した場合は、警告を表示し、宣言の中身を使わず既定値を返す', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`schema: 2` のように未対応の番号を渡した場合に、`schema` と `2` を含む警告が 1 件返り、宣言は既定値になることを確認します。')
    const { declaration, warnings } = parseThemeDeclaration({ schema: 2, fontSizes: { heading: 99 } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('schema')
    expect(warnings[0]).toContain('2')
    expect(declaration).toEqual(DEFAULT_THEME_DECLARATION)
  })

  it('schema が存在しない宣言は、理由 invalid-shape のエラーを返す', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`schema` を持たない宣言を渡した場合に、理由 `invalid-shape` のエラーが発生し、メッセージに `schema` が含まれることを確認します。')
    const error = thrownBy(() => parseThemeDeclaration({ slide: { width: 1, height: 1 } }))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('schema')
  })

  it('オブジェクトでない宣言は、理由 invalid-shape のエラーを返す', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。空の配列や文字列のようにオブジェクトでない値を渡した場合に、理由 `invalid-shape` のエラーが発生することを確認します。')
    expect(thrownBy(() => parseThemeDeclaration([])).reason).toBe('invalid-shape')
    expect(thrownBy(() => parseThemeDeclaration([])).message).toContain('contracts/theme-declaration.md')
    expect(thrownBy(() => parseThemeDeclaration('x')).reason).toBe('invalid-shape')
  })

  it('未対応の lint の規則名を指定した場合は、理由 unknown-rule のエラーに規則名を含める', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`slidev-pages-lint/no-such-rule` のように存在しない規則名を渡した場合に、理由 `unknown-rule` のエラーが発生し、メッセージに規則名が含まれることを確認します。')
    const error = thrownBy(() => parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'slidev-pages-lint/no-such-rule': 'error' } },
    }))
    expect(error.reason).toBe('unknown-rule')
    expect(error.message).toContain('slidev-pages-lint/no-such-rule')
    expect(error.message).toContain('the "lint.rules" part of the `pecot-theme.json` section of contracts/theme-declaration.md')
  })

  it('対応している規則名と重さ（error・warn・off）は、そのまま受け付ける', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。既存の規則名に `warn` と `off` を指定した場合に、エラーにならず、指定した重さがそのまま返ることを確認します。')
    const { declaration } = parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'text-constraints/max-chars': 'warn', 'slidev-pages-lint/no-scaled-drawio': 'off' } },
    })
    expect(declaration.lint.rules).toEqual({
      'text-constraints/max-chars': 'warn',
      'slidev-pages-lint/no-scaled-drawio': 'off',
    })
  })

  it('規則の重さが error・warn・off のいずれでもない場合は、理由 invalid-shape のエラーを返す', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。規則の重さに `loud` を指定した場合に、理由 `invalid-shape` のエラーが発生することを確認します。')
    const error = thrownBy(() => parseThemeDeclaration({
      schema: 1,
      lint: { rules: { 'text-constraints/max-chars': 'loud' } },
    }))
    expect(error.reason).toBe('invalid-shape')
  })

  it('linkColor は 6 桁の 16 進数だけを受け付ける', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`pptx.linkColor` に `#fff` を指定した場合は理由 `invalid-shape` のエラーになり、`a1B2c3` を指定した場合はそのまま受け付けることを確認します。')
    expect(thrownBy(() => parseThemeDeclaration({ schema: 1, pptx: { linkColor: '#fff' } })).reason).toBe('invalid-shape')
    expect(parseThemeDeclaration({ schema: 1, pptx: { linkColor: 'a1B2c3' } }).declaration.pptx.linkColor).toBe('a1B2c3')
  })

  it('スライドの寸法が正の数でない場合は、理由 invalid-shape のエラーを返す', async () => {
    await explains('宣言を解析する `parseThemeDeclaration` のテストです。`slide.width` に 0 を指定した場合に、理由 `invalid-shape` のエラーが発生し、メッセージに `slide.width` が含まれることを確認します。')
    const error = thrownBy(() => parseThemeDeclaration({ schema: 1, slide: { width: 0, height: 540 } }))
    expect(error.reason).toBe('invalid-shape')
    expect(error.message).toContain('slide.width')
  })
})
