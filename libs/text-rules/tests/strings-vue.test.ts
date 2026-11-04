import { describe, expect, it } from 'vitest'
import { documentOf } from '../lib/plugins/inline-spans.js'
import strings, { stringParagraphs } from '../lib/plugins/strings.js'
import { at, lint, lintAll, sentence } from './helpers/strings.js'

const template = (body: string): string => `<template>\n${body}\n</template>\n`
const script = (body: string, attributes = ''): string => `<template><div></div></template>\n<script${attributes}>\n${body}\n</script>\n`
const style = (body: string): string => `<template><div></div></template>\n<style scoped>\n${body}\n</style>\n`

describe('strings plugin: .vue の template', () => {
  it.each([
    ['テキスト', template(`  <div>${sentence}</div>`), at(2, 8)],
    ['属性値', template(`  <div title="${sentence}"></div>`), at(2, 15)],
    ['bind した式の中の文字列', template(`  <div :title="'${sentence}'"></div>`), at(2, 17)],
    ['補間 {{ }} の中の文字列', template(`  <div>{{ '${sentence}' }}</div>`), at(2, 12)],
    ['補間の中のテンプレート文字列', template(`  <div>{{ \`${sentence}\${1}\` }}</div>`), at(2, 12)],
    ['HTML コメント', template(`  <!-- ${sentence} -->`), at(2, 8)],
    ['自己終了タグの後ろの属性値', template(`  <br />\n  <MyInput title="${sentence}" />`), at(3, 19)],
    ['属性値の中の >', template(`  <div title="a > ${sentence}">x</div>`), at(2, 19)],
    ['単引用符の属性値の中の二重引用符', template(`  <div title='say "${sentence}"'></div>`), at(2, 20)],
    ['v-bind のオブジェクトの中の文字列', template(`  <div v-bind="{ title: '${sentence}' }"></div>`), at(2, 26)],
    ['@click の文の中の文字列', template(`  <button @click="a = 1; b = '${sentence}'">x</button>`), at(2, 31)],
    ['スロットの分割代入と v-for を持つ要素の本文', template(`  <Comp #default="{ item }" v-for="x in xs">${sentence}</Comp>`), at(2, 45)],
    ['引用符の無い属性値の後ろの属性値', template(`  <div class=a title="${sentence}"></div>`), at(2, 23)],
    ['属性の間の単独の /', template(`  <div / title="${sentence}"></div>`), at(2, 17)],
    ['閉じていないコメント', `<template>\n  <!-- ${sentence}\n`, at(2, 8)],
    ['閉じていない補間の開始は本文として読む', template(`  <p>{{ ${sentence}</p>`), at(2, 9)],
    ['閉じていない template', `<template>\n  <p>${sentence}</p>\n`, at(2, 6)],
  ])('%s の違反を元ファイルの行と列で返す', async (_name, text, hit) => {
    expect(await lint(text, '.vue')).toEqual([hit])
  })

  it('入れ子の template の後ろの要素と、template の後ろの script まで読む', async () => {
    const text = [
      '<template>',
      '  <template v-if="ok">',
      `    <p>${sentence}</p>`,
      '  </template>',
      `  <p>${sentence}</p>`,
      '</template>',
      '<script>',
      `const a = '${sentence}'`,
      '</script>',
      '',
    ].join('\n')
    expect(await lint(text, '.vue')).toEqual([at(3, 8), at(5, 6), at(8, 12)])
  })

  it('補間で分けたテキストは、それぞれ別の Paragraph にする', async () => {
    const paragraphs = await stringParagraphs(template('  <p>あ{{ n }}い<b>う</b></p>'), '.vue')
    expect(paragraphs.map(paragraph => paragraph.raw)).toEqual(['あ', 'い', 'う'])
  })

  it('テキスト以外の違反の無い文言と、日本語を含まない template は数えない', async () => {
    expect(await lintAll(template('  <div title="今日は晴れです。">今日は晴れです。</div>'), '.vue')).toEqual([])
    expect(await stringParagraphs(template('  <div title="a" :b="\'c\'">{{ d }} e</div>'), '.vue')).toEqual([])
  })

  it('タグの名前が続かない < は本文の文字として読む', async () => {
    expect(await lint(template(`  <p>1 < 2 ${sentence}</p>`), '.vue')).toEqual([at(2, 12)])
  })

  it('lang が html でない template は読まない', async () => {
    expect(await lint(`<template lang="pug">\np ${sentence}\n</template>\n`, '.vue')).toEqual([])
    expect(await lint(`<template lang="html">\n${sentence}\n</template>\n`, '.vue')).toEqual([at(2, 1)])
  })

  it('template の中の script と style は、中身を HTML として読まない', async () => {
    expect(await lint(template(`<script>const x = '${sentence}'</script><style>/* ${sentence} */</style>`), '.vue')).toEqual([])
  })
})

describe('strings plugin: .vue の script', () => {
  it.each([
    ['// コメント', script(`// ${sentence}\nconst a = 1`), at(3, 4)],
    ['ブロックコメント', script(`/* ${sentence} */\nconst a = 1`), at(3, 4)],
    ['文字列', script(`const a = '${sentence}'`), at(3, 12)],
    ['lang="ts" の型注釈つきの文字列', script(`const a: string = '${sentence}'`, ' setup lang="ts"'), at(3, 20)],
    ['lang="tsx" の JSX 属性', script(`const a = <div title="${sentence}" />`, ' lang="tsx"'), at(3, 23)],
    ['lang="jsx"', script(`const a = <div title="${sentence}" />`, ' lang="jsx"'), at(3, 23)],
    ['閉じていない script', `<script>\nconst a = '${sentence}'\n`, at(2, 12)],
  ])('%s の違反を元ファイルの行と列で返す', async (_name, text, hit) => {
    expect(await lint(text, '.vue')).toEqual([hit])
  })

  it('script と script setup の両方を読む', async () => {
    const text = `<script>\nconst a = '${sentence}'\n</script>\n<script setup lang="ts">\nconst b: string = '${sentence}'\n</script>\n`
    expect(await lint(text, '.vue')).toEqual([at(2, 12), at(5, 20)])
  })

  it('script のコメントを 1 件だけ返す（strings と comments の二重に数えない）', async () => {
    expect(await lintAll(script(`// ${sentence}`), '.vue')).toHaveLength(1)
  })
})

describe('strings plugin: .vue の style とその他', () => {
  it('style の /* */ コメントの違反を返す', async () => {
    expect(await lint(style(`/* ${sentence} */\n.a { color: red; }`), '.vue')).toEqual([at(3, 4)])
  })

  it('閉じていないコメントは style の末尾までを読む', async () => {
    expect(await lint(style(`.a { color: red; }\n/* ${sentence}`), '.vue')).toEqual([at(4, 4)])
  })

  it('複数行コメントの行頭の * を Str に含めず、続きの行を同じ Paragraph にする', async () => {
    const [paragraph] = await stringParagraphs(style('/**\n * あ\n * い\n */'), '.vue')
    expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', 'あ'], ['Break', '\n * '], ['Str', 'い']])
    expect(await lint(style(`/**\n * ${sentence}\n */`), '.vue')).toEqual([at(4, 4)])
  })

  it('style の文字列と、// は読まない', async () => {
    expect(await lint(style(`.a::after { content: "${sentence}"; } // ${sentence}`), '.vue')).toEqual([])
  })

  it('ブロックの外のタグでない < と終了タグを読み飛ばして、後ろの script を読む', async () => {
    expect(await lint(`1 < 2 </div>\n<br/>\n<script>\nconst a = '${sentence}'\n</script>\n`, '.vue')).toEqual([at(4, 12)])
  })

  it('カスタムブロックと、ブロックの外のコメントは読まない', async () => {
    expect(await lint(`<!-- ${sentence} -->\n<i18n>\n{"a": "${sentence}"}\n</i18n>\n`, '.vue')).toEqual([])
  })

  it('空のファイルと、BOM 付きのファイル', async () => {
    expect(await stringParagraphs('', '.vue')).toEqual([])
    expect(await lint(`\u{FEFF}${template(`  <p>${sentence}</p>`)}`, '.vue')).toEqual([at(2, 6)])
  })
})

describe('Processor: .vue', () => {
  it('script のコメントと template と script の文字列を range の順に並べた Document を返す', async () => {
    const text = `<template><p>${sentence}</p></template>\n<script>\n// ${sentence}\nconst a = '${sentence}'\n</script>\n`
    const result = documentOf(await new strings.Processor().processor('.vue').preProcess(text))
    expect(result.type).toBe('Document')
    expect(result.range).toEqual([0, text.length])
    expect(result.children.map(child => child.loc.start.line)).toEqual([1, 3, 4])
    expect(result.children.some(child => 'parent' in child)).toBe(false)
  })
})
