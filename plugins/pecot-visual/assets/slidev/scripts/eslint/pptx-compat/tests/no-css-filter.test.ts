import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noCssFilter from '../lib/rules/no-css-filter.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-css-filter', noCssFilter, {
  valid: [
    {
      name: 'data-pptx-image の子孫の静的な class に当たる filter なら、報告しない',
      code: `<template><div><div data-pptx-image><span class="icon  big"></span></div></div></template><style scoped>.big { filter: brightness(0); }</style>`,
      filename: 'test.vue',
    },
    {
      name: 'data-pptx-image の子孫の :class のオブジェクトのキー（識別子と文字列）に当たる filter なら、報告しない',
      code: `<template><div><div data-pptx-image><span :class="{ 'x-y': a, zed: b }"></span></div></div></template><style scoped>.x-y { filter: brightness(0); } .zed { filter: invert(1); }</style>`,
      filename: 'test.vue',
    },
    {
      name: 'data-pptx-image の子孫の :class の配列の文字列に当たる filter なら、報告しない',
      code: `<template><div><div data-pptx-image><span :class="['arr-a', { objb: x }]"></span></div></div></template><style scoped>.arr-a { filter: sepia(1); }</style>`,
      filename: 'test.vue',
    },
    {
      name: 'data-pptx-image の子孫の :class の配列の中のオブジェクトに当たる filter なら、報告しない',
      code: `<template><div><div data-pptx-image><span :class="['arr-a', { objb: x }]"></span></div></div></template><style scoped>.objb { filter: sepia(1); }</style>`,
      filename: 'test.vue',
    },
    {
      name: 'data-pptx-image の子孫の孫要素の class に当たる filter なら、報告しない',
      code: `<template><div><div data-pptx-image><div><span class="deep"></span></div></div></div></template><style scoped>.deep { filter: grayscale(1); }</style>`,
      filename: 'test.vue',
    },
    {
      name: 'data-pptx-image が兄弟要素の後ろの入れ子にあっても、その子孫の class に当たる filter なら、報告しない',
      code: `<template><div><p>text</p><section><div data-pptx-image><i class="late"></i></div></section></div></template><style scoped>.late { filter: contrast(2); }</style>`,
      filename: 'test.vue',
    },
    // filterなし
    {
      name: 'filter を指定しないと、報告しない',
      code: '<template><div></div></template><style scoped>.box { color: red; }</style>',
      filename: 'test.vue',
    },
    // filter: none は無害
    {
      name: 'filter が none なら、報告しない',
      code: '<template><div></div></template><style scoped>.box { filter: none; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      name: 'style ブロックが無いと、報告しない',
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // filter: blur()のみはdom-to-pptxで対応済み
    {
      name: 'filter が blur() だけなら、報告しない',
      code: '<template><div></div></template><style scoped>.glow { filter: blur(30px); }</style>',
      filename: 'test.vue',
    },
    // backdrop-filterはトリガーしない
    {
      name: 'backdrop-filter だけなら、報告しない',
      code: '<template><div></div></template><style scoped>.box { backdrop-filter: blur(4px); }</style>',
      filename: 'test.vue',
    },
    // data-pptx-image祖先内のfilter（画像化コンポーネント）
    {
      name: 'data-pptx-image の祖先の中の filter なら、報告しない',
      code: '<template><div data-pptx-image><div></div></div></template><style scoped>.box { filter: brightness(0); }</style>',
      filename: 'test.vue',
    },
    // @keyframes内のfilterは除外
    {
      name: '@keyframes の中の filter なら、報告しない',
      code: `<template><div></div></template>
<style scoped>
.icon {
  animation: icon-fade 0.3s both;
}
@keyframes icon-fade {
  0% {
    filter: brightness(0);
  }
  100% {
    filter: none;
  }
}
</style>`,
      filename: 'test.vue',
    },
  ],

  invalid: [
    {
      name: 'data-pptx-image の外の class に当たる filter だと、報告する',
      code: `<template><div><div data-pptx-image><span class="inside"></span></div><span class="outside"></span></div></template><style scoped>.outside { filter: brightness(0); }</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    {
      name: 'data-pptx-image の子孫の :class が計算キー・スプレッド・数値だけだと、その class 名の filter を報告する',
      code: `<template><div><div data-pptx-image><span :class="{ [k]: a, ...rest }"></span><b :class="[, 1]"></b><i :class="cls" class=""></i></div></div></template><style scoped>.cls { filter: brightness(0); }</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // filter: brightness(0)
    {
      name: 'filter: brightness(0) を指定すると、報告する',
      code: '<template><div></div></template><style scoped>.icon { filter: brightness(0); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // filter: grayscale(100%)
    {
      name: 'filter: grayscale(100%) を指定すると、報告する',
      code: '<template><div></div></template><style scoped>.icon { filter: grayscale(100%); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // 複合filterチェーン
    {
      name: 'filter を複数の関数でつなぐと、報告する',
      code: '<template><div></div></template><style scoped>.icon { filter: brightness(0) saturate(100%) invert(65%); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // 複数styleブロック
    {
      name: 'style ブロックが複数あり、それぞれに filter があると、ブロックごとに報告する',
      code: '<template><div></div></template><style>.a { filter: brightness(0); }</style><style scoped>.b { filter: grayscale(100%); }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noCssFilter' },
        { messageId: 'noCssFilter' },
      ],
    },
  ],
});
