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
    // filterなし
    {
      code: '<template><div></div></template><style scoped>.box { color: red; }</style>',
      filename: 'test.vue',
    },
    // filter: none は無害
    {
      code: '<template><div></div></template><style scoped>.box { filter: none; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // filter: blur()のみはdom-to-pptxで対応済み
    {
      code: '<template><div></div></template><style scoped>.glow { filter: blur(30px); }</style>',
      filename: 'test.vue',
    },
    // backdrop-filterはトリガーしない
    {
      code: '<template><div></div></template><style scoped>.box { backdrop-filter: blur(4px); }</style>',
      filename: 'test.vue',
    },
    // data-pptx-image祖先内のfilter（画像化コンポーネント）
    {
      code: '<template><div data-pptx-image><div></div></div></template><style scoped>.box { filter: brightness(0); }</style>',
      filename: 'test.vue',
    },
    // @keyframes内のfilterは除外
    {
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
    // filter: brightness(0)
    {
      code: '<template><div></div></template><style scoped>.icon { filter: brightness(0); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // filter: grayscale(100%)
    {
      code: '<template><div></div></template><style scoped>.icon { filter: grayscale(100%); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // 複合filterチェーン
    {
      code: '<template><div></div></template><style scoped>.icon { filter: brightness(0) saturate(100%) invert(65%); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noCssFilter' }],
    },
    // 複数styleブロック
    {
      code: '<template><div></div></template><style>.a { filter: brightness(0); }</style><style scoped>.b { filter: grayscale(100%); }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noCssFilter' },
        { messageId: 'noCssFilter' },
      ],
    },
  ],
});

console.log('All no-css-filter tests passed!');
