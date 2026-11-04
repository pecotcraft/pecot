import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noLineHeightCentering from '../lib/rules/no-line-height-centering.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-line-height-centering', noLineHeightCentering, {
  valid: [
    // line-heightが相対値（問題なし）
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 1.15; }</style>',
      filename: 'test.vue',
    },
    // heightとline-heightが異なる絶対値
    {
      code: '<template><div></div></template><style scoped>.icon { height: 48px; line-height: 24px; }</style>',
      filename: 'test.vue',
    },
    // line-heightのみ（heightなし）
    {
      code: '<template><div></div></template><style scoped>.text { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // heightのみ（line-heightなし）
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; }</style>',
      filename: 'test.vue',
    },
    // padding-topで物理配置（問題なし）
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; padding-top: 7px; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // 子セレクタだが親にheightがない
    {
      code: '<template><div></div></template><style scoped>.icon { color: red; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // 子セレクタで親のheightと異なる値
    {
      code: '<template><div></div></template><style scoped>.icon { height: 48px; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // line-height: normal は相対値扱い
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: normal; }</style>',
      filename: 'test.vue',
    },
    // 親依存サイズ + 相対line-height → OK
    {
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; } .bar p { line-height: 1.5; }</style>',
      filename: 'test.vue',
    },
    // 親依存サイズでline-heightなし → OK
    {
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; padding: 14px; }</style>',
      filename: 'test.vue',
    },
    // width:100% のみ（height 固定値）で異なる line-height は OK。
    // 親依存ではなく、パターン2でも `height!=line-height`。
    {
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 48px; } .bar p { line-height: 24px; }</style>',
      filename: 'test.vue',
    },
    // narrow（#686）: height==line-height でも vertical-align:middle 併用なら valid。
    // dom-to-pptx 1.1.8+ で verticalAlign:middle → anchor="ctr"、lnSpc は箱高相当で暴走しない
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 32px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow: パターン2（親 height==子 line-height）でも line-height を持つ要素に vertical-align:middle 併用なら valid
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; } .icon p { line-height: 32px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow: 親依存サイズ + 絶対 line-height でも vertical-align:middle 併用なら valid
    {
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; line-height: 48px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow（#686, F-05）: パターン3b（親が親依存サイズ・子に絶対 line-height）の場合。
    // line-height を持つ子に vertical-align:middle を併用すれば valid。
    // L110-113 の valign 分岐は、3b でも有効になる。
    {
      code: '<template><div></div></template><style scoped>.closing-bar { width: 100%; height: 100%; } .closing-bar .msg { line-height: 48px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // 同セレクタ内でheightとline-heightが同値
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // 子セレクタのline-heightが親のheightと同値
    {
      code: '<template><div></div></template><style scoped>.icon { height: 32px; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // 複数のスタイルブロックにまたがるケース
    {
      code: '<template><div></div></template><style>.badge { height: 24px; line-height: 24px; }</style><style scoped>.tag { height: 20px; line-height: 20px; }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'lineHeightCentering' },
        { messageId: 'lineHeightCentering' },
      ],
    },
    // 小数px値でも検出
    {
      code: '<template><div></div></template><style scoped>.icon { height: 28.5px; line-height: 28.5px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // パターン3a: 同セレクタ内で親依存+絶対line-height
    {
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; line-height: 48px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
    // パターン3b: 親が親依存 + 子に絶対line-height（MClosingBar修正前パターン）
    {
      code: '<template><div></div></template><style scoped>.closing-bar { width: 100%; height: 100%; } .closing-bar .msg { line-height: 48px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
    // パターン3b: 深いネスト
    {
      code: '<template><div></div></template><style scoped>.wrap { width: 100%; height: 100%; } .wrap .inner p { line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
  ],
});

console.log('All no-line-height-centering tests passed!');
