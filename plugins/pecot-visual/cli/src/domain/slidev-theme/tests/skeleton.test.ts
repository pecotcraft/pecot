import { describe, expect, it } from 'vitest'

import { extractSkeleton, isFrontmatterBlock } from '../skeleton.js'

describe('extractSkeleton', () => {
  it('ブロック内の空行を保ち、末尾の空行は落とす', () => {
    const reference = [
      'examples:',
      '  - name: 空行入り',
      '    frontmatter: |',
      '      ---',
      '      layout: sample',
      '',
      '      title: あとがき',
      '      ---',
      '',
      'text_constraints:',
      '  title: 10',
      '',
    ].join('\n')

    expect(extractSkeleton(reference)).toBe('---\nlayout: sample\n\ntitle: あとがき\n---\n')
  })

  it('frontmatter ブロックを持たない参照は undefined を返す', () => {
    expect(extractSkeleton('examples:\n  - name: 雛形なし\n    note: 説明だけ\n')).toBeUndefined()
  })

  it('マーカーの直後に本文が無い参照は undefined を返す', () => {
    expect(extractSkeleton('examples:\n  - name: 空\n    frontmatter: |\ntext_constraints:\n')).toBeUndefined()
  })

  it('examples より手前の frontmatter ブロックは拾わない', () => {
    // props の説明などに書かれた例を雛形として書き出すと、examples の内容と食い違う。
    const reference = [
      'props:',
      '  title:',
      '    note: |',
      '      frontmatter: |',
      '      ---',
      '      layout: 説明の中の例',
      '      ---',
      'examples:',
      '  - name: 基本',
      '    frontmatter: |',
      '      ---',
      '      layout: sample',
      '      ---',
    ].join('\n')

    expect(extractSkeleton(reference)).toBe('---\nlayout: sample\n---\n')
  })

  it('examples を持たない参照は undefined を返す', () => {
    const reference = 'props:\n  title:\n    frontmatter: |\n      ---\n      layout: sample\n      ---\n'

    expect(extractSkeleton(reference)).toBeUndefined()
  })

  it('行頭アンカーが働き、値の中の frontmatter には当たらない', () => {
    // media-right-code.yaml の codeSrc: .../sample-frontmatter.yaml と同じ形。
    const reference = [
      'examples:',
      '  - name: コード',
      '    codeSrc: /slides/code/sample-frontmatter.yaml',
      '    frontmatter: |',
      '      ---',
      '      layout: media-right-code',
      '      ---',
    ].join('\n')

    expect(extractSkeleton(reference)).toBe('---\nlayout: media-right-code\n---\n')
  })
})

describe('isFrontmatterBlock', () => {
  it('--- で囲まれた雛形は成立する', () => {
    expect(isFrontmatterBlock('---\nlayout: sample\n---\n')).toBe(true)
  })

  it('囲みの無い雛形は成立しない', () => {
    expect(isFrontmatterBlock('layout: sample\n')).toBe(false)
  })

  it('末尾の --- が無い雛形は成立しない', () => {
    expect(isFrontmatterBlock('---\nlayout: sample\n')).toBe(false)
  })

  it('--- 1 本だけの雛形は成立しない', () => {
    expect(isFrontmatterBlock('---\n')).toBe(false)
  })
})
