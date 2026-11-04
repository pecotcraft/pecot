import type { Scanner, Segment } from './scan.js'
import { typescriptStrings } from './typescript.js'
import type { Grammar } from './typescript.js'

// Vue の単一ファイルコンポーネント（SFC）を最上位のブロックに分け、文章として読む区間を取り出す。
// script は TypeScript の文字列とコメント、template は HTML コメントとテキストと属性値（式は文字列）、style は `/* */` のコメントを読む。
// 構文解析は元ファイルの位置を保つため、読む区間以外を空白に置き換えた同じ長さの本文に対して行う。

interface Attribute {
  readonly name: string
  // 引用符で囲んだ値の本文。引用符の無い値と値の無い属性は undefined。
  readonly value?: Segment
}

interface Tag {
  readonly name: string
  readonly isClosing: boolean
  readonly isSelfClosing: boolean
  readonly attributes: readonly Attribute[]
  // 閉じの `>` の直後。
  readonly end: number
}

const TAG_OPEN = /<(\/?)([a-z][^\s/>]*)/iy
const WHITESPACE = /\s/

// index から、stops のどれかの文字（または空白）が現れる位置まで進める。
function wordEnd(text: string, index: number, stops: string): number {
  let end = index
  while (end < text.length && !stops.includes(text.charAt(end)) && !WHITESPACE.test(text.charAt(end))) {
    end += 1
  }
  return end
}

function skipSpaces(text: string, index: number): number {
  let end = index
  while (end < text.length && WHITESPACE.test(text.charAt(end))) {
    end += 1
  }
  return end
}

// 引用符で囲んだ値は、閉じる引用符までを読む（値の中の `>` と別の引用符では終わらない）。閉じなければ入力の末尾まで。
function attributeValue(text: string, index: number): { value?: Segment, next: number } {
  const quote = text.charAt(index)
  if (quote === '"' || quote === '\'') {
    const close = text.indexOf(quote, index + 1)
    const end = close === -1 ? text.length : close
    return { value: { start: index + 1, end }, next: end + 1 }
  }
  return { next: wordEnd(text, index, '>') }
}

// index の `<` から始まる開始タグ・終了タグを読む。タグの名前が続かなければ undefined。
function readTag(text: string, index: number): Tag | undefined {
  TAG_OPEN.lastIndex = index
  const opening = TAG_OPEN.exec(text)
  if (opening === null) {
    return undefined
  }
  const tag = { name: opening[2] ?? '', isClosing: opening[1] === '/' }
  const attributes: Attribute[] = []
  let cursor = index + opening[0].length
  while (cursor < text.length) {
    cursor = skipSpaces(text, cursor)
    const isSelfClosing = text.startsWith('/>', cursor)
    if (isSelfClosing || text.charAt(cursor) === '>') {
      return { ...tag, isSelfClosing, attributes, end: cursor + (isSelfClosing ? 2 : 1) }
    }
    const nameEnd = wordEnd(text, cursor, '=/>')
    if (nameEnd === cursor) {
      cursor += 1
      continue
    }
    const name = text.slice(cursor, nameEnd)
    const equals = skipSpaces(text, nameEnd)
    if (text.charAt(equals) === '=') {
      const { value, next } = attributeValue(text, skipSpaces(text, equals + 1))
      attributes.push(value === undefined ? { name } : { name, value })
      cursor = next
    }
    else {
      attributes.push({ name })
      cursor = nameEnd
    }
  }
  return { ...tag, isSelfClosing: false, attributes, end: text.length }
}

function langOf(text: string, tag: Readonly<Tag>): string | undefined {
  const value = tag.attributes.find(attribute => attribute.name === 'lang')?.value
  return value === undefined ? undefined : text.slice(value.start, value.end)
}

// `:` `@` `#` `v-` で始まる属性の値は、文章ではなく式。
function isDirective(name: string): boolean {
  return /^(?:[:@#]|v-)/.test(name)
}

// `<!--`、`<タグ`、`</タグ` の位置を探す。`{{ }}` の中の `<` は式の一部なので読み飛ばす。
function markupIndex(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const close = text.startsWith('{{', index) ? text.indexOf('}}', index + 2) : -1
    if (close !== -1) {
      index = close + 2
    }
    else if (text.charAt(index) === '<') {
      return index
    }
    else {
      index += 1
    }
  }
  return -1
}

interface Parts {
  readonly texts: readonly Segment[]
  readonly expressions: readonly Segment[]
}

// タグの間のテキストを、`{{ }}` の外の本文と、中の式に分ける。
function textParts(text: string, start: number, end: number): Parts {
  const texts: Segment[] = []
  const expressions: Segment[] = []
  let cursor = start
  while (cursor < end) {
    const open = text.indexOf('{{', cursor)
    const close = open === -1 || open >= end ? -1 : text.indexOf('}}', open + 2)
    if (close === -1) {
      texts.push({ start: cursor, end })
      break
    }
    texts.push({ start: cursor, end: open })
    expressions.push({ start: open + 2, end: close })
    cursor = close + 2
  }
  return { texts, expressions }
}

interface Template extends Parts {
  // 対応する `</template>` の直後。閉じなければ入力の末尾。
  readonly next: number
}

// script と style の中身は HTML として読まず、閉じタグの直後まで読み飛ばす。
function rawElementEnd(text: string, tag: Readonly<Tag>): number {
  const close = text.indexOf(`</${tag.name}`, tag.end)
  return close === -1 ? text.length : (readTag(text, close)?.end ?? text.length)
}

// from（`<template>` の直後）から対応する `</template>` までを読む。入れ子の `<template>` は深さを数える。
function scanTemplate(text: string, from: number): Template {
  const texts: Segment[] = []
  const expressions: Segment[] = []
  const addText = (start: number, end: number): void => {
    const parts = textParts(text, start, end)
    texts.push(...parts.texts)
    expressions.push(...parts.expressions)
  }
  let depth = 0
  let cursor = from
  let textStart = from
  for (let open = markupIndex(text, cursor); open !== -1; open = markupIndex(text, cursor)) {
    if (text.startsWith('<!--', open)) {
      addText(textStart, open)
      const close = text.indexOf('-->', open + 4)
      texts.push({ start: open + 4, end: close === -1 ? text.length : close })
      cursor = close === -1 ? text.length : close + 3
      textStart = cursor
      continue
    }
    const tag = readTag(text, open)
    if (tag === undefined) {
      cursor = open + 1
      continue
    }
    addText(textStart, open)
    const name = tag.name.toLowerCase()
    if (name === 'template' && depth === 0 && tag.isClosing) {
      return { texts, expressions, next: tag.end }
    }
    for (const attribute of tag.attributes) {
      if (attribute.value !== undefined) {
        (isDirective(attribute.name) ? expressions : texts).push(attribute.value)
      }
    }
    if (name === 'template') {
      depth += tag.isClosing ? -1 : Number(!tag.isSelfClosing)
    }
    cursor = !tag.isClosing && !tag.isSelfClosing && (name === 'script' || name === 'style') ? rawElementEnd(text, tag) : tag.end
    textStart = cursor
  }
  addText(textStart, text.length)
  return { texts, expressions, next: text.length }
}

// style の `/* */` コメントの本文。閉じなければ style の終わりまで。
function styleComments(text: string, content: Readonly<Segment>): readonly Segment[] {
  const comments: Segment[] = []
  let open = text.indexOf('/*', content.start)
  while (open !== -1 && open < content.end) {
    const close = text.indexOf('*/', open + 2)
    const end = close === -1 || close > content.end ? content.end : close
    comments.push({ start: open + 2, end, blockComment: true })
    open = text.indexOf('/*', end)
  }
  return comments
}

interface Script {
  readonly grammar: Grammar
  readonly content: Segment
}

interface Sfc {
  readonly scripts: readonly Script[]
  readonly styles: readonly Segment[]
  readonly templateTexts: readonly Segment[]
  readonly expressions: readonly Segment[]
}

const SCRIPT_GRAMMARS: ReadonlyMap<string, Grammar> = new Map([
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
])

function sfcOf(text: string): Sfc {
  const scripts: Script[] = []
  const styles: Segment[] = []
  const templateTexts: Segment[] = []
  const expressions: Segment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor)
    if (open === -1) {
      break
    }
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4)
      cursor = close === -1 ? text.length : close + 3
      continue
    }
    const tag = readTag(text, open)
    if (tag === undefined || tag.isClosing || tag.isSelfClosing) {
      cursor = tag?.end ?? open + 1
      continue
    }
    const name = tag.name.toLowerCase()
    if (name === 'template') {
      const template = scanTemplate(text, tag.end)
      const lang = langOf(text, tag)
      if (lang === undefined || lang === 'html') {
        templateTexts.push(...template.texts)
        expressions.push(...template.expressions)
      }
      cursor = template.next
      continue
    }
    const close = text.indexOf(`</${tag.name}`, tag.end)
    const content = { start: tag.end, end: close === -1 ? text.length : close }
    if (name === 'script') {
      scripts.push({ grammar: SCRIPT_GRAMMARS.get(langOf(text, tag) ?? '') ?? 'javascript', content })
    }
    else if (name === 'style') {
      styles.push(...styleComments(text, content))
    }
    cursor = rawElementEnd(text, tag)
  }
  return { scripts, styles, templateTexts, expressions }
}

// vueScripts（コメント）と vueStrings（文字列）は preProcess の中で同じ本文を続けて読むので、直前の分割を使い回す。
const cache: { text?: string, sfc?: Sfc } = {}

function sharedSfc(text: string): Sfc {
  if (cache.text !== text || cache.sfc === undefined) {
    cache.sfc = sfcOf(text)
    cache.text = text
  }
  return cache.sfc
}

function blank(text: string): string {
  return text.replaceAll(/[^\n\r]/g, ' ')
}

// keeps の区間だけを残し、他の文字を空白に置き換えた、同じ長さの本文。改行は残して行を保つ。
// isFenced のときは各区間の前後を `;` にして、区間ごとに独立した文として解析させる。
function maskedText(text: string, keeps: readonly Segment[], isFenced: boolean): string {
  let cursor = 0
  let masked = ''
  for (const { start, end } of keeps) {
    const fence = isFenced ? ';' : ''
    const closing = isFenced && end < text.length ? ';' : ''
    masked += blank(text.slice(cursor, start - fence.length)) + fence + text.slice(start, end) + closing
    cursor = end + closing.length
  }
  return masked + blank(text.slice(cursor))
}

export interface VueScript {
  readonly grammar: Grammar
  // script の中身だけを残した、元ファイルと同じ長さの本文。
  readonly masked: string
}

export function vueScripts(text: string): readonly VueScript[] {
  return sharedSfc(text).scripts.map(({ grammar, content }) => ({ grammar, masked: maskedText(text, [content], false) }))
}

export const vueStrings: Scanner = async (text) => {
  const sfc = sharedSfc(text)
  const scripts = await Promise.all(sfc.scripts.map(async ({ grammar, content }) => typescriptStrings(grammar)(maskedText(text, [content], false))))
  const expressions = await typescriptStrings('typescript')(maskedText(text, sfc.expressions, true))
  return [...scripts.flat(), ...expressions, ...sfc.templateTexts, ...sfc.styles]
}
