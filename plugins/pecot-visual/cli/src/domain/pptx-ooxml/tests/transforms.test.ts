import { describe, expect, it } from 'vitest'

import { applyMutation } from '../transforms.js'
import { parseTestXml, serializeTestXml } from '../../../../tests/unit/domain/_helpers/xmldom-engine.js'

const NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main' }

describe('applyMutation', () => {
  it('set-attr: 既存属性を上書きする', () => {
    const document = parseTestXml('<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:rPr lang="en-US"/></a:r>')
    const [rpr] = document.selectNodes('//a:rPr', NS)
    if (rpr === undefined) throw new Error('rPr not found')

    applyMutation(rpr, { kind: 'set-attr', name: 'lang', value: 'ja-JP' })

    expect(rpr.getAttr('lang')).toBe('ja-JP')
    expect(serializeTestXml(document)).toContain('lang="ja-JP"')
  })

  it('set-attr: 未設定の属性を新規付与する', () => {
    const document = parseTestXml('<a:r xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:rPr/></a:r>')
    const [rpr] = document.selectNodes('//a:rPr', NS)
    if (rpr === undefined) throw new Error('rPr not found')

    applyMutation(rpr, { kind: 'set-attr', name: 'spc', value: '105' })

    expect(rpr.getAttr('spc')).toBe('105')
  })

  it('set-text: 既存のテキストノードを置き換える', () => {
    const document = parseTestXml('<a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">old</a:t>')
    const [t] = document.selectNodes('//a:t', NS)
    if (t === undefined) throw new Error('a:t not found')

    applyMutation(t, { kind: 'set-text', value: 'new' })

    expect(t.text()).toBe('new')
  })

  it('remove: 自ノードを親から外す', () => {
    const document = parseTestXml('<root><a:item xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:item xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></root>')
    const [first] = document.selectNodes('//a:item', NS)
    if (first === undefined) throw new Error('a:item not found')

    applyMutation(first, { kind: 'remove' })

    expect(document.selectNodes('//a:item', NS)).toHaveLength(1)
  })

  it('replace-with-xml: 自ノードを XML 文字列の新ノードで置換する', () => {
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
