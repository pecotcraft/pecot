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
      name: 'p の中の span なら、報告しない',
      code: '<template><p><span class="highlight">text</span></p></template>',
      filename: 'test.vue',
    },
    // <h1>内の<span>は正当
    {
      name: 'h1 の中の span なら、報告しない',
      code: '<template><h1><span class="accent">title</span></h1></template>',
      filename: 'test.vue',
    },
    // <li>内の<span>は正当
    {
      name: 'li の中の span なら、報告しない',
      code: '<template><li><span class="item">list item</span></li></template>',
      filename: 'test.vue',
    },
    // <a>内の<span>は正当
    {
      name: 'a の中の span なら、報告しない',
      code: '<template><a href="#"><span class="link-text">click</span></a></template>',
      filename: 'test.vue',
    },
    // classなしの<span>はスキップ
    {
      name: 'class の無い span なら、報告しない',
      code: '<template><div><span>plain text</span></div></template>',
      filename: 'test.vue',
    },
    // 子要素を含む<span>はスキップ（テキストラッパーではない）
    {
      name: '子要素を含む span なら、報告しない',
      code: '<template><div><span class="wrapper"><strong>bold</strong></span></div></template>',
      filename: 'test.vue',
    },
    // <div>を使用（正しいパターン）
    {
      name: 'div を使ってテキストを包むと、報告しない',
      code: '<template><div><div class="description">text</div></div></template>',
      filename: 'test.vue',
    },
    // <td>内の<span>は正当（インライン要素の親）
    {
      name: 'td の中の span なら、報告しない',
      code: '<template><table><tr><td><span class="cell-text">data</span></td></tr></table></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <div>直下の<span>テキストラッパー
    {
      name: 'div 直下の class 付き span がテキストを包むと、報告する',
      code: '<template><div><span class="description">some text</span></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // <section>直下の<span>テキストラッパー
    {
      name: 'section 直下の class 付き span がテキストを包むと、報告する',
      code: '<template><section><span class="label">label text</span></section></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // テンプレート式を含む<span>
    {
      name: 'テンプレート式だけを包む class 付き span があると、報告する',
      code: '<template><div><span class="page">{{ pageNumber }}</span></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noSpanTextWrapper' }],
    },
    // 複数の違反
    {
      name: '違反する span が複数あると、すべて報告する',
      code: '<template><div><span class="title">Title</span><span class="sub">Sub</span></div></template>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noSpanTextWrapper' },
        { messageId: 'noSpanTextWrapper' },
      ],
    },
  ],
});
