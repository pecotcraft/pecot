import { describe, expect, it } from 'vitest'

import { extractSkeleton, isFrontmatterBlock } from '../skeleton.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('extractSkeleton', () => {
  it('ブロック内の空行は残し、末尾の空行は取り除く', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`frontmatter` のブロックの途中に空行がある場合に、その空行を残し、ブロックの後ろの空行を含めずに取り出すことを確認します。')
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

  it('frontmatter ブロックを持たない参照は undefined を返す', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`examples` に `frontmatter` のブロックが存在しない場合に、`undefined` を返すことを確認します。')
    expect(extractSkeleton('examples:\n  - name: 雛形なし\n    note: 説明だけ\n')).toBeUndefined()
  })

  it('frontmatter の記号の直後に本文が存在しない参照は、undefined を返す', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`frontmatter: |` の直後に本文の行が存在しない場合に、`undefined` を返すことを確認します。')
    expect(extractSkeleton('examples:\n  - name: 空\n    frontmatter: |\ntext_constraints:\n')).toBeUndefined()
  })

  it('examples より前にある frontmatter のブロックは、雛形として取り出さない', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`props` の説明の中に `frontmatter` の例がある場合に、`examples` の中の雛形だけを取り出すことを確認します。')
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

  it('examples を持たない参照は undefined を返す', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`examples` が存在せず、ほかの場所に `frontmatter` のブロックがある場合に、`undefined` を返すことを確認します。')
    const reference = 'props:\n  title:\n    frontmatter: |\n      ---\n      layout: sample\n      ---\n'

    expect(extractSkeleton(reference)).toBeUndefined()
  })

  it('値の途中にある frontmatter の文字列には反応せず、行頭の frontmatter だけを雛形にする', async () => {
    await explains('参照から雛形を取り出す `extractSkeleton` のテストです。`codeSrc` の値に `sample-frontmatter.yaml` のように `frontmatter` を含む場合に、行頭の `frontmatter:` のブロックだけを取り出すことを確認します。')
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
  it('--- で囲まれた雛形は、frontmatter として有効と判定する', async () => {
    await explains('雛形の形を判定する `isFrontmatterBlock` のテストです。先頭と末尾が `---` の行で囲まれている場合に、`true` を返すことを確認します。')
    expect(isFrontmatterBlock('---\nlayout: sample\n---\n')).toBe(true)
  })

  it('--- で囲まれていない雛形は、frontmatter として無効と判定する', async () => {
    await explains('雛形の形を判定する `isFrontmatterBlock` のテストです。`---` の行が存在しない場合に、`false` を返すことを確認します。')
    expect(isFrontmatterBlock('layout: sample\n')).toBe(false)
  })

  it('末尾の --- が存在しない雛形は、frontmatter として無効と判定する', async () => {
    await explains('雛形の形を判定する `isFrontmatterBlock` のテストです。先頭の `---` だけがあり、閉じる `---` が存在しない場合に、`false` を返すことを確認します。')
    expect(isFrontmatterBlock('---\nlayout: sample\n')).toBe(false)
  })

  it('--- が 1 行だけの雛形は、frontmatter として無効と判定する', async () => {
    await explains('雛形の形を判定する `isFrontmatterBlock` のテストです。`---` の行しか存在しない場合に、`false` を返すことを確認します。')
    expect(isFrontmatterBlock('---\n')).toBe(false)
  })
})
