import { describe, expect, it } from 'vitest'

import { applyMutation } from '../transforms.js'
import { parseTestXml, serializeTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main' }

describe('applyMutation', () => {
  it('set-attr の場合は、既存の属性の値を上書きする', async () => {
    await explains('XML のノードを変更する `applyMutation` の、`set-attr` のテストです。`lang` 属性を持つ要素に新しい値を指定した場合に、属性の値が上書きされ、シリアライズした XML にも反映されることを確認します。')
    const document = parseTestXml('<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:rPr lang="en-US"/></a:r>')
    const [rpr] = document.selectNodes('//a:rPr', NS)
    if (rpr === undefined) throw new Error('rPr not found')

    applyMutation(rpr, { kind: 'set-attr', name: 'lang', value: 'ja-JP' })

    expect(rpr.getAttr('lang')).toBe('ja-JP')
    expect(serializeTestXml(document)).toContain('lang="ja-JP"')
  })

  it('set-attr の場合は、未設定の属性を新しく追加する', async () => {
    await explains('XML のノードを変更する `applyMutation` の、`set-attr` のテストです。属性を持たない要素に `spc` を指定した場合に、属性が追加されることを確認します。')
    const document = parseTestXml('<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:rPr/></a:r>')
    const [rpr] = document.selectNodes('//a:rPr', NS)
    if (rpr === undefined) throw new Error('rPr not found')

    applyMutation(rpr, { kind: 'set-attr', name: 'spc', value: '105' })

    expect(rpr.getAttr('spc')).toBe('105')
  })

  it('set-text の場合は、既存のテキストノードの内容を置き換える', async () => {
    await explains('XML のノードを変更する `applyMutation` の、`set-text` のテストです。テキストを持つ要素に新しい文字列を指定した場合に、テキストが置き換わることを確認します。')
    const document = parseTestXml('<a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">old</a:t>')
    const [t] = document.selectNodes('//a:t', NS)
    if (t === undefined) throw new Error('a:t not found')

    applyMutation(t, { kind: 'set-text', value: 'new' })

    expect(t.text()).toBe('new')
  })

  it('remove の場合は、対象のノードを親から取り除く', async () => {
    await explains('XML のノードを変更する `applyMutation` の、`remove` のテストです。同じ名前の要素が 2 つある場合に、最初の要素を取り除き、残りが 1 つになることを確認します。')
    const document = parseTestXml('<root><a:item xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:item xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></root>')
    const [first] = document.selectNodes('//a:item', NS)
    if (first === undefined) throw new Error('a:item not found')

    applyMutation(first, { kind: 'remove' })

    expect(document.selectNodes('//a:item', NS)).toHaveLength(1)
  })

  it('replace-with-xml の場合は、対象のノードを、XML の文字列から作成した新しいノードに置き換える', async () => {
    await explains('XML のノードを変更する `applyMutation` の、`replace-with-xml` のテストです。元の要素が存在しなくなり、指定した XML の文字列から作成した要素（`id` が `42`）に置き換わることを確認します。')
    const document = parseTestXml('<root><a:placeholder xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></root>')
    const [placeholder] = document.selectNodes('//a:placeholder', NS)
    if (placeholder === undefined) throw new Error('placeholder not found')

    applyMutation(placeholder, {
      kind: 'replace-with-xml',
      xml: '<a:replacement xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" id="42"/>',
    })

    expect(document.selectNodes('//a:placeholder', NS)).toHaveLength(0)
    const [replacement] = document.selectNodes('//a:replacement', NS)
    expect(replacement?.getAttr('id')).toBe('42')
  })
})
