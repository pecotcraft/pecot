import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noCompositeBorderOnText from '../lib/rules/no-composite-border-on-text.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-composite-border-on-text', noCompositeBorderOnText, {
  valid: [
    {
      name: 'p の :style に border 以外のキーしか無いと、報告しない',
      code: `<template><p :style="{ color: c, 'margin-left': m }">x</p></template>`,
      filename: 'test.vue',
    },
    {
      name: 'p の :style がオブジェクトでなく変数だと、報告しない',
      code: '<template><p :style="styleVar">x</p></template>',
      filename: 'test.vue',
    },
    {
      name: 'p の :style が計算キーとスプレッドだけだと、報告しない',
      code: '<template><p :style="{ [k]: 1, ...rest }">x</p></template>',
      filename: 'test.vue',
    },
    {
      name: 'p の :style に値が無いと、報告しない',
      code: '<template><p :style>x</p></template>',
      filename: 'test.vue',
    },
    {
      name: 'p の style に辺ごとでない border しか無いと、報告しない',
      code: '<template><p style="color: red; border: 1px solid #000">x</p></template>',
      filename: 'test.vue',
    },
    {
      name: 'p の style が空だと、報告しない',
      code: '<template><p style="">x</p></template>',
      filename: 'test.vue',
    },
    {
      name: 'class の指定が style ブロックのどのルールにも辺ごとの border を持たないと、報告しない',
      code: '<template><p class="a b">x</p></template><style scoped>.c { border-left: 1px solid; } .a { color: red; }</style>',
      filename: 'test.vue',
    },
    {
      name: 'コメントの中だけにある border-left は、報告しない',
      code: '<template><p class="t">x</p></template><style scoped>/* .t { border-left: 1px solid; } */ .t { color: red; }</style>',
      filename: 'test.vue',
    },
    {
      name: 'class 名に似た別のクラスにだけ border-left があると、報告しない',
      code: '<template><p class="t">x</p></template><style scoped>.tt { border-left: 1px solid; }</style>',
      filename: 'test.vue',
    },
    // 均一 shorthand border は許可
    {
      name: 'border を 1 つの shorthand で均一に指定すると、報告しない',
      code: '<template><p class="t">x</p></template><style scoped>.t { border: 1px solid #000; }</style>',
      filename: 'test.vue',
    },
    // border-width / border-style / border-color のみ（個別辺指定なし）も許可
    {
      name: 'border-width と border-style だけを指定すると、報告しない',
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-width: 1px; border-style: solid; }</style>',
      filename: 'test.vue',
    },
    // border 無し
    {
      name: 'border を指定しないと、報告しない',
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { color: #000; }</style>',
      filename: 'test.vue',
    },
    // 非テキスト要素 (div) の composite border は対象外
    {
      name: 'div の辺ごとの border は、報告しない',
      code: '<template><div class="t"></div></template><style scoped>.t { border-left: 4px solid #000; }</style>',
      filename: 'test.vue',
    },
    // section/article などブロック要素も対象外
    {
      name: 'section など block 要素の辺ごとの border は、報告しない',
      code: '<template><section class="t"><p>x</p></section></template><style scoped>.t { border-bottom: 1px solid; }</style>',
      filename: 'test.vue',
    },
    // style ブロック無し
    {
      name: 'style ブロックが無いと、報告しない',
      code: '<template><p>x</p></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    {
      name: 'p の style に border-left を指定すると、報告する',
      code: '<template><p style="color: red; border-left: 4px solid #000">x</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    {
      name: 'p の :style に borderLeft の識別子のキーを指定すると、報告する',
      code: '<template><p :style="{ borderLeft: w }">x</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    {
      name: 'h2 の :style に borderTopColor の文字列のキーを指定すると、報告する',
      code: `<template><h2 :style="{ 'borderTopColor': c }">x</h2></template>`,
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    {
      name: '2 つ目の class にだけ border-bottom があっても、報告する',
      code: '<template><p class="a b">x</p></template><style scoped>.a { color: red; } .b { border-bottom: 1px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    {
      name: '2 つ目の style ブロックにだけ border-left があっても、報告する',
      code: '<template><p class="t">x</p></template><style>.u { color: red; }</style><style scoped>.t:hover { border-left: 1px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <p> + border-left
    {
      name: 'p に border-left を指定すると、報告する',
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left: 4px solid #000; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <p> + border-right
    {
      name: 'p に border-right を指定すると、報告する',
      code: '<template><p class="t">x</p></template><style scoped>.t { border-right: 2px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <p> + border-top
    {
      name: 'p に border-top を指定すると、報告する',
      code: '<template><p class="t">x</p></template><style scoped>.t { border-top: 1px dashed #ccc; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <h1> + border-bottom
    {
      name: 'h1 に border-bottom を指定すると、報告する',
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-bottom: 2px solid #ccc; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <h2>〜<h6> 全 heading レベルが対象であること（代表例 h3）
    {
      name: 'h3 に border-left を指定すると、見出しのレベルによらず報告する',
      code: '<template><h3 class="t">x</h3></template><style scoped>.t { border-left: 3px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // border-top-width のみ（longhand width だけ）
    {
      name: 'h1 に border-top-width だけを指定すると、報告する',
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-top-width: 1px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // border-left-width longhand
    {
      name: 'p に border-left-width だけを指定すると、報告する',
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left-width: 4px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // 複数辺の混在（border-left + border-right）も検出（要素単位で 1 件）
    {
      name: 'p に border-left と border-right を並べると、要素ごとに 1 件を報告する',
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left: 2px solid; border-right: 2px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
  ],
});
