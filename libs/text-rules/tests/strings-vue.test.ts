import { describe, expect, it } from 'vitest'
import { documentOf } from '../lib/plugins/inline-spans.js'
import strings, { stringParagraphs } from '../lib/plugins/strings.js'
import { at, lint, lintAll, sentence } from './helpers/strings.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

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
  ])('%s に違反があると、元のファイルの行と桁で指摘を返す', async (name, text, hit) => {
    await explains(`\`.vue\` ファイルの \`<template>\` から文を取り出す strings plugin のテストです。\`<template>\` の「${name}」に違反がある場合に、指摘を 1 件だけ返し、その位置が元のファイルの行と桁と一致することを確認します。`)
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.vue')).toEqual([hit])
    })
  })

  it('入れ子の template があっても、その後ろの要素と、template の後ろの script まで読む', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。`<template>` が入れ子になっている場合に、内側の `<template>` の中と後ろの要素、さらに後ろの `<script>` の文字列まで読み、3 件の指摘を返すことを確認します。')
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
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.vue')).toEqual([at(3, 8), at(5, 6), at(8, 12)])
    })
  })

  it('補間で区切られたテキストを、それぞれ別の段落にする', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。`{{ n }}` の補間やタグで区切られたテキストを渡した場合に、区切られたテキストごとに別の段落として取り出されることを確認します。')
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(template('  <p>あ{{ n }}い<b>う</b></p>'), '.vue'))
    stepSync('段落の文字列を比べる', () => {
      expect(paragraphs.map(paragraph => paragraph.raw)).toEqual(['あ', 'い', 'う'])
    })
  })

  it('違反の無い日本語の文と、日本語を含まない template は、数えない', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。違反の無い日本語の文と、日本語を含まないテキストを渡した場合に、指摘が 1 件も返らず、段落も取り出されないことを確認します。')
    await step('日本語を含まない template を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintAll(template('  <div title="今日は晴れです。">今日は晴れです。</div>'), '.vue')).toEqual([])
      expect(await stringParagraphs(template('  <div title="a" :b="\'c\'">{{ d }} e</div>'), '.vue')).toEqual([])
    })
  })

  it('タグの名前が続かない < は、タグではなく、本文の文字として読む', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。`1 < 2` のように、`<` の後ろにタグの名前が続かない場合に、`<` を本文の文字として読み、後ろの文の違反を返すことを確認します。')
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(template(`  <p>1 < 2 ${sentence}</p>`), '.vue')).toEqual([at(2, 12)])
    })
  })

  it('lang が html ではない template は読まず、html の template は読む', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。`lang="pug"` の `<template>` は読まれず、`lang="html"` の `<template>` は読まれて指摘が返ることを確認します。')
    await step('pug の template を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`<template lang="pug">\np ${sentence}\n</template>\n`, '.vue')).toEqual([])
    })
    await step('html の template を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`<template lang="html">\n${sentence}\n</template>\n`, '.vue')).toEqual([at(2, 1)])
    })
  })

  it('template の中の script と style は、中身を HTML として読まない', async () => {
    await explains('`.vue` ファイルの `<template>` から文を取り出す strings plugin のテストです。`<template>` の中に `<script>` と `<style>` がある場合に、それぞれの中身を HTML として読まず、指摘が 1 件も返らないことを確認します。')
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(template(`<script>const x = '${sentence}'</script><style>/* ${sentence} */</style>`), '.vue')).toEqual([])
    })
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
  ])('%s に違反があると、元のファイルの行と桁で指摘を返す', async (name, text, hit) => {
    await explains(`\`.vue\` ファイルの \`<script>\` から文を取り出す strings plugin のテストです。\`<script>\` の「${name}」に違反がある場合に、指摘を 1 件だけ返し、その位置が元のファイルの行と桁と一致することを確認します。`)
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.vue')).toEqual([hit])
    })
  })

  it('script と script setup が両方あると、どちらの違反も返す', async () => {
    await explains('`.vue` ファイルの `<script>` から文を取り出す strings plugin のテストです。`<script>` と `<script setup>` の両方に違反がある場合に、2 つの違反が元のファイルの位置で返ることを確認します。')
    const text = `<script>\nconst a = '${sentence}'\n</script>\n<script setup lang="ts">\nconst b: string = '${sentence}'\n</script>\n`
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.vue')).toEqual([at(2, 12), at(5, 20)])
    })
  })

  it('script のコメントの違反を 1 件だけ返し、strings と comments で二重に返さない', async () => {
    await explains('`.vue` ファイルの `<script>` から文を取り出す strings plugin のテストです。`<script>` のコメントに違反がある場合に、文字列を調べる plugin とコメントを調べる plugin の両方で数えず、指摘が 1 件だけ返ることを確認します。')
    await step('script のコメントを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lintAll(script(`// ${sentence}`), '.vue')).toHaveLength(1)
    })
  })
})

describe('strings plugin: .vue の style とその他', () => {
  it('style の /* */ コメントに違反があると、その位置を指摘として返す', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。`<style>` の `/* */` コメントに違反がある場合に、元のファイルの位置で指摘を返すことを確認します。')
    await step('style のコメントを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(style(`/* ${sentence} */\n.a { color: red; }`), '.vue')).toEqual([at(3, 4)])
    })
  })

  it('閉じていないコメントは、style の末尾までをコメントとして読む', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。`<style>` の中で `/*` が閉じていない場合に、末尾までをコメントとして読み、その中の違反を返すことを確認します。')
    await step('閉じていないコメントを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(style(`.a { color: red; }\n/* ${sentence}`), '.vue')).toEqual([at(4, 4)])
    })
  })

  it('複数行のコメントの行頭の * を本文に含めず、続きの行を同じ段落にする', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。`<style>` の複数行のコメントを渡した場合に、行頭の `*` が本文の文字に含まれず、続きの行が同じ段落の子になり、違反の位置が元のファイルと一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs(style('/**\n * あ\n * い\n */'), '.vue'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', 'あ'], ['Break', '\n * '], ['Str', 'い']])
    })
    await step('コメントを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(style(`/**\n * ${sentence}\n */`), '.vue')).toEqual([at(4, 4)])
    })
  })

  it('style の文字列と // は、コメントとして読まない', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。`<style>` の中の文字列と `//` に違反のある文があっても、コメントではないので、指摘が 1 件も返らないことを確認します。')
    await step('style の文字列を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(style(`.a::after { content: "${sentence}"; } // ${sentence}`), '.vue')).toEqual([])
    })
  })

  it('ブロックの外にあるタグではない < と終了タグを読み飛ばし、後ろの script を読む', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。ブロックの外に `1 < 2` と終了タグがある場合に、それらを読み飛ばし、後ろの `<script>` の文字列の違反を返すことを確認します。')
    await step('Vue の文言を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`1 < 2 </div>\n<br/>\n<script>\nconst a = '${sentence}'\n</script>\n`, '.vue')).toEqual([at(4, 12)])
    })
  })

  it('カスタムブロックと、ブロックの外のコメントは読まない', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。`<i18n>` のカスタムブロックと、ブロックの外の HTML コメントに違反がある場合に、どちらも読まず、指摘が 1 件も返らないことを確認します。')
    await step('カスタムブロックを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`<!-- ${sentence} -->\n<i18n>\n{"a": "${sentence}"}\n</i18n>\n`, '.vue')).toEqual([])
    })
  })

  it('空のファイルは段落を取り出さず、BOM 付きのファイルは BOM を除いた位置で指摘を返す', async () => {
    await explains('`.vue` ファイルの `<style>` やその他の部分から文を取り出す strings plugin のテストです。空のファイルを渡した場合に段落が取り出されず、先頭に BOM があるファイルを渡した場合に、BOM を除いた位置で指摘が返ることを確認します。')
    await step('空のファイルを段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('', '.vue')).toEqual([])
    })
    await step('BOM 付きのファイルを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`\u{FEFF}${template(`  <p>${sentence}</p>`)}`, '.vue')).toEqual([at(2, 6)])
    })
  })
})

describe('Processor: .vue', () => {
  it('script のコメントと、template と script の文字列を、位置の順に並べた Document を返す', async () => {
    await explains('`.vue` ファイルを Document に変換する Processor のテストです。コメントと文字列を含む `.vue` ファイルを渡した場合に、`Document` の範囲が全文になり、子の要素が位置の順に 3 つ並び、`parent` を持たないことを確認します。')
    const text = `<template><p>${sentence}</p></template>\n<script>\n// ${sentence}\nconst a = '${sentence}'\n</script>\n`
    const result = await step('Document を作る', async () => documentOf(await new strings.Processor().processor('.vue').preProcess(text)))
    stepSync('Document の形を比べる', () => {
      expect(result.type).toBe('Document')
      expect(result.range).toEqual([0, text.length])
      expect(result.children.map(child => child.loc.start.line)).toEqual([1, 3, 4])
      expect(result.children.some(child => 'parent' in child)).toBe(false)
    })
  })
})
