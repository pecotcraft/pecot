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
      name: 'line-height が相対値なら、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 1.15; }</style>',
      filename: 'test.vue',
    },
    // heightとline-heightが異なる絶対値
    {
      name: 'height と line-height が異なる絶対値なら、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 48px; line-height: 24px; }</style>',
      filename: 'test.vue',
    },
    // line-heightのみ（heightなし）
    {
      name: 'line-height だけで height が無いと、報告しない',
      code: '<template><div></div></template><style scoped>.text { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // heightのみ（line-heightなし）
    {
      name: 'height だけで line-height が無いと、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; }</style>',
      filename: 'test.vue',
    },
    // padding-topで物理配置（問題なし）
    {
      name: 'padding-top で位置を決めていると、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; padding-top: 7px; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      name: 'style ブロックが無いと、報告しない',
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // 子セレクタだが親にheightがない
    {
      name: '子セレクタの親に height が無いと、報告しない',
      code: '<template><div></div></template><style scoped>.icon { color: red; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // 子セレクタで親のheightと異なる値
    {
      name: '子セレクタの line-height が親の height と異なると、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 48px; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
    },
    // line-height: normal は相対値扱い
    {
      name: 'line-height が normal なら、相対値として報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: normal; }</style>',
      filename: 'test.vue',
    },
    // 親依存サイズ + 相対line-height → OK
    {
      name: '親依存のサイズに相対 line-height を組み合わせると、報告しない',
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; } .bar p { line-height: 1.5; }</style>',
      filename: 'test.vue',
    },
    // 親依存サイズでline-heightなし → OK
    {
      name: '親依存のサイズで line-height が無いと、報告しない',
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; padding: 14px; }</style>',
      filename: 'test.vue',
    },
    // width:100% のみ（height 固定値）で異なる line-height は OK。
    // 親依存ではなく、パターン2でも `height!=line-height`。
    {
      name: 'width が 100% でも height が固定値で line-height と異なると、報告しない',
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 48px; } .bar p { line-height: 24px; }</style>',
      filename: 'test.vue',
    },
    // narrow（#686）: height==line-height でも vertical-align:middle 併用なら valid。
    // dom-to-pptx 1.1.8+ で verticalAlign:middle → anchor="ctr"、lnSpc は箱高相当で暴走しない
    {
      name: 'height と line-height が同じでも vertical-align: middle を併用すると、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 32px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow: パターン2（親 height==子 line-height）でも line-height を持つ要素に vertical-align:middle 併用なら valid
    {
      name: '親の height と子の line-height が同じでも、子に vertical-align: middle を併用すると、報告しない',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; } .icon p { line-height: 32px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow: 親依存サイズ + 絶対 line-height でも vertical-align:middle 併用なら valid
    {
      name: '親依存のサイズに絶対 line-height でも vertical-align: middle を併用すると、報告しない',
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; line-height: 48px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
    // narrow（#686, F-05）: パターン3b（親が親依存サイズ・子に絶対 line-height）の場合。
    // line-height を持つ子に vertical-align:middle を併用すれば valid。
    // L110-113 の valign 分岐は、3b でも有効になる。
    {
      name: '親が親依存のサイズで子に絶対 line-height でも、子に vertical-align: middle を併用すると、報告しない',
      code: '<template><div></div></template><style scoped>.closing-bar { width: 100%; height: 100%; } .closing-bar .msg { line-height: 48px; vertical-align: middle; }</style>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // 同セレクタ内でheightとline-heightが同値
    {
      name: '同じセレクタで height と line-height が同じ値だと、報告する',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // 子セレクタのline-heightが親のheightと同値
    {
      name: '子セレクタの line-height が親の height と同じ値だと、報告する',
      code: '<template><div></div></template><style scoped>.icon { height: 32px; } .icon p { line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // 複数のスタイルブロックにまたがるケース
    {
      name: 'style ブロックが複数あり、それぞれで height と line-height が同じだと、ブロックごとに報告する',
      code: '<template><div></div></template><style>.badge { height: 24px; line-height: 24px; }</style><style scoped>.tag { height: 20px; line-height: 20px; }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'lineHeightCentering' },
        { messageId: 'lineHeightCentering' },
      ],
    },
    // 小数px値でも検出
    {
      name: 'height と line-height が同じ小数 px の値でも、報告する',
      code: '<template><div></div></template><style scoped>.icon { height: 28.5px; line-height: 28.5px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'lineHeightCentering' }],
    },
    // パターン3a: 同セレクタ内で親依存+絶対line-height
    {
      name: '同じセレクタで親依存のサイズに絶対 line-height を指定すると、報告する',
      code: '<template><div></div></template><style scoped>.bar { width: 100%; height: 100%; line-height: 48px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
    // パターン3b: 親が親依存 + 子に絶対line-height（MClosingBar修正前パターン）
    {
      name: '親が親依存のサイズで子に絶対 line-height を指定すると、報告する',
      code: '<template><div></div></template><style scoped>.closing-bar { width: 100%; height: 100%; } .closing-bar .msg { line-height: 48px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
    // パターン3b: 深いネスト
    {
      name: '親が親依存のサイズで深く入れ子の子に絶対 line-height を指定すると、報告する',
      code: '<template><div></div></template><style scoped>.wrap { width: 100%; height: 100%; } .wrap .inner p { line-height: 32px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'parentDependentLineHeight' }],
    },
  ],
});
