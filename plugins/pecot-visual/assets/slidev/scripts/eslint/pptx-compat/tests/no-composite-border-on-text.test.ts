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
    // 均一 shorthand border は許可
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border: 1px solid #000; }</style>',
      filename: 'test.vue',
    },
    // border-width / border-style / border-color のみ（個別辺指定なし）も許可
    {
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-width: 1px; border-style: solid; }</style>',
      filename: 'test.vue',
    },
    // border 無し
    {
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { color: #000; }</style>',
      filename: 'test.vue',
    },
    // 非テキスト要素 (div) の composite border は対象外
    {
      code: '<template><div class="t"></div></template><style scoped>.t { border-left: 4px solid #000; }</style>',
      filename: 'test.vue',
    },
    // section/article などブロック要素も対象外
    {
      code: '<template><section class="t"><p>x</p></section></template><style scoped>.t { border-bottom: 1px solid; }</style>',
      filename: 'test.vue',
    },
    // style ブロック無し
    {
      code: '<template><p>x</p></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <p> + border-left
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left: 4px solid #000; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <p> + border-right
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border-right: 2px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <p> + border-top
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border-top: 1px dashed #ccc; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <h1> + border-bottom
    {
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-bottom: 2px solid #ccc; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // <h2>〜<h6> 全 heading レベルが対象であること（代表例 h3）
    {
      code: '<template><h3 class="t">x</h3></template><style scoped>.t { border-left: 3px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // border-top-width のみ（longhand width だけ）
    {
      code: '<template><h1 class="t">x</h1></template><style scoped>.t { border-top-width: 1px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // border-left-width longhand
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left-width: 4px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
    // 複数辺の混在（border-left + border-right）も検出（要素単位で 1 件）
    {
      code: '<template><p class="t">x</p></template><style scoped>.t { border-left: 2px solid; border-right: 2px solid; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'compositeBorder' }],
    },
  ],
});

console.log('All no-composite-border-on-text tests passed!');
