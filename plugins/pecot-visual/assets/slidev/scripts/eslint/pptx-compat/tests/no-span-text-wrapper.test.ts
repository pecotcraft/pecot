import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noSpanTextWrapper from '../lib/rules/no-span-text-wrapper.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-span-text-wrapper', noSpanTextWrapper, {
  valid: [
    // <p>内の<span>はインライン装飾として正当
    {
      code: '<template><p><span class="highlight">text</span></p></template>',
      filename: 'test.vue',
    },
    // <h1>内の<span>は正当
    {
      code: '<template><h1><span class="accent">title</span></h1></template>',
      filename: 'test.vue',
    },
    // <li>内の<span>は正当
    {
      code: '<template><li><span class="item">list item</span></li></template>',
      filename: 'test.vue',
    },
    // <a>内の<span>は正当
    {
      code: '<template><a href="#"><span class="link-text">click</span></a></template>',
      filename: 'test.vue',
    },
    // classなしの<span>はスキップ
    {
      code: '<template><div><span>plain text</span></div></template>',
      filename: 'test.vue',
    },
    // 子要素を含む<span>はスキップ（テキストラッパーではない）
    {
      code: '<template><div><span class="wrapper"><strong>bold</strong></span></div></template>',
      filename: 'test.vue',
    },
    // <div>を使用（正しいパターン）
    {
      code: '<template><div><div class="description">text</div></div></template>',
      filename: 'test.vue',
    },
    // <td>内の<span>は正当（インライン要素の親）
    {
      code: '<template><table><tr><td><span class="cell-text">data</span></td></tr></table></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <div>直下の<span>テキストラッパー
    {
      code: '<template><div><span class="description">some text</span></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // <section>直下の<span>テキストラッパー
    {
      code: '<template><section><span class="label">label text</span></section></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // テンプレート式を含む<span>
    {
      code: '<template><div><span class="page">{{ pageNumber }}</span></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // 複数の違反
    {
      code: '<template><div><span class="title">Title</span><span class="sub">Sub</span></div></template>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noSpanTextWrapper' },
        { messageId: 'noSpanTextWrapper' },
      ],
    },
  ],
});

console.log('All no-span-text-wrapper tests passed!');
