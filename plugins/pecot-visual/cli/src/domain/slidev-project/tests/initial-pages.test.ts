// buildInitialPages / nameToTitle の挙動検証。
// テーマの参照 yaml はメモリ上の ThemeFiles（I/O 境界）で与える。

import { describe, expect, it } from 'vitest'

import type { ThemeFiles } from '../../slidev-theme/ports.js'
import type { LayoutReference } from '../../slidev-theme/references.js'
import { buildInitialPages, nameToTitle } from '../initial-pages.js'

function memoryFiles(texts: Readonly<Record<string, string>>): ThemeFiles {
  const stored = new Map(Object.entries(texts))
  return {
    readText: path => Promise.resolve(stored.get(path)),
    listFiles: () => Promise.resolve([]),
  }
}

function reference(name: string, extension: 'yaml' | 'vue' = 'yaml'): LayoutReference {
  return {
    name,
    description: '',
    category: 'uncategorized',
    status: 'stable',
    file: `/theme/references/${name}.${extension}`,
  }
}

function referenceText(name: string, skeleton: string | undefined): string {
  const lines = [`layout: '${name}'`, 'description: sample']
  if (skeleton !== undefined) {
    lines.push(
      'examples:',
      '  - name: 基本',
      '    frontmatter: |',
      ...skeleton.split('\n').filter(line => line !== '').map(line => `      ${line}`),
    )
  }
  return `${lines.join('\n')}\n`
}

function skeletonOf(name: string, title: string): string {
  return `---\nlayout: ${name}\ntitle: ${title}\n---\n`
}

describe('buildInitialPages', () => {
  it('cover・agenda・section・end の順に、examples の 1 件目の雛形をそのまま書く', async () => {
    const names = ['agenda', 'cover', 'end', 'section', 'zeta']
    const texts = Object.fromEntries(
      names.map(name => [`/theme/references/${name}.yaml`, referenceText(name, skeletonOf(name, `${name} 見出し`))]),
    )
    const result = await buildInitialPages(names.map(name => reference(name)), memoryFiles(texts))
    expect(result.warnings).toStrictEqual([])
    expect(result.pages).toStrictEqual([
      { filename: 'cover.md', content: skeletonOf('cover', 'cover 見出し') },
      { filename: 'agenda.md', content: skeletonOf('agenda', 'agenda 見出し') },
      { filename: 'section.md', content: skeletonOf('section', 'section 見出し') },
      { filename: 'end.md', content: skeletonOf('end', 'end 見出し') },
    ])
  })

  it('4 つのうち宣言の無いもの、examples の無いものは飛ばす', async () => {
    const texts = {
      '/theme/references/cover.yaml': referenceText('cover', skeletonOf('cover', '表紙')),
      '/theme/references/section.yaml': referenceText('section', undefined),
      '/theme/references/end.yaml': referenceText('end', skeletonOf('end', '終わり')),
    }
    const result = await buildInitialPages(
      [reference('cover'), reference('section'), reference('end')],
      memoryFiles(texts),
    )
    expect(result.pages.map(page => page.filename)).toStrictEqual(['cover.md', 'end.md'])
    expect(result.warnings).toStrictEqual([])
  })

  it('4 つとも無ければ、examples を持つ名前順で最初のレイアウトを 1 ページだけ書く', async () => {
    const texts = {
      '/theme/references/marked.yaml': referenceText('marked', undefined),
      '/theme/references/panel.yaml': referenceText('panel', skeletonOf('panel', '図')),
      '/theme/references/plain.yaml': referenceText('plain', skeletonOf('plain', '本文')),
    }
    const result = await buildInitialPages(
      [reference('plain'), reference('marked'), reference('panel')],
      memoryFiles(texts),
    )
    expect(result.pages).toStrictEqual([{ filename: 'panel.md', content: skeletonOf('panel', '図') }])
    expect(result.warnings).toStrictEqual([])
  })

  it('examples が 1 つも無ければ、先頭のレイアウトを layout だけで 1 ページ書き、警告を返す', async () => {
    const texts = { '/theme/references/plain.yaml': referenceText('plain', undefined) }
    const result = await buildInitialPages([reference('plain'), reference('panel')], memoryFiles(texts))
    expect(result.pages).toStrictEqual([{ filename: 'panel.md', content: '---\nlayout: panel\n---\n' }])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('layout: panel')
    expect(result.warnings[0]).toContain('examples')
  })

  it('宣言の無いテーマ（vue だけ）は yaml を読まず、layout だけの 1 ページと警告にする', async () => {
    const result = await buildInitialPages([reference('plain', 'vue')], memoryFiles({}))
    expect(result.pages).toStrictEqual([{ filename: 'plain.md', content: '---\nlayout: plain\n---\n' }])
    expect(result.warnings).toHaveLength(1)
  })

  it('参照の yaml が読めなければ examples が無いものとして扱う', async () => {
    const result = await buildInitialPages([reference('cover')], memoryFiles({}))
    expect(result.pages).toStrictEqual([{ filename: 'cover.md', content: '---\nlayout: cover\n---\n' }])
    expect(result.warnings).toHaveLength(1)
  })

  it('レイアウトが 1 つも無ければ、ページは空で警告を返す', async () => {
    const result = await buildInitialPages([], memoryFiles({}))
    expect(result.pages).toStrictEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('layouts/')
  })
})

describe('buildInitialPages (ページ名に使えないレイアウト名)', () => {
  it.each(['../escape', 'a/b', '.hidden', '', 'x y'])('レイアウト名 %j は警告して飛ばし、ファイルを作らない', async (name) => {
    const texts = {
      [`/theme/references/${name}.yaml`]: referenceText(name, skeletonOf('cover', '表紙')),
      '/theme/references/plain.yaml': referenceText('plain', skeletonOf('plain', '本文')),
    }

    const result = await buildInitialPages([reference(name), reference('plain')], memoryFiles(texts))

    expect(result.pages.map(page => page.filename)).toStrictEqual(['plain.md'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(`'${name}'`)
  })

  it('使えない名前しか無いときは、警告だけを返し、ページを作らない', async () => {
    const result = await buildInitialPages([reference('../escape')], memoryFiles({}))

    expect(result.pages).toStrictEqual([])
    expect(result.warnings).toHaveLength(2)
  })

  it('cover が使えない名前に当たらなくても、使える名前の layout だけの警告に飛ばした分の警告を足す', async () => {
    const result = await buildInitialPages([reference('../escape'), reference('plain')], memoryFiles({}))

    expect(result.pages).toStrictEqual([{ filename: 'plain.md', content: '---\nlayout: plain\n---\n' }])
    expect(result.warnings).toHaveLength(2)
  })
})

describe('nameToTitle', () => {
  it('ハイフンをスペースに置換し各単語の先頭を大文字化する', () => {
    expect(nameToTitle('my-cool-talk')).toBe('My Cool Talk')
  })

  it('既に大文字と小文字が併存していても各単語先頭を大文字にする', () => {
    expect(nameToTitle('quick-START')).toBe('Quick START')
  })

  it('単語境界を持たない 1 単語はそのまま先頭大文字', () => {
    expect(nameToTitle('hello')).toBe('Hello')
  })
})
