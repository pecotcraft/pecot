import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noShrinkwrapAbsolute from '../lib/rules/no-shrinkwrap-absolute.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-shrinkwrap-absolute', noShrinkwrapAbsolute, {
  valid: [
    // 水平: left + right で両側指定
    {
      code: '<template><div></div></template><style scoped>.title { position: absolute; left: 0; right: 0; top: 13px; height: 30px; }</style>',
      filename: 'test.vue',
    },
    // 水平: left + width で幅指定
    {
      code: '<template><div></div></template><style scoped>.title { position: absolute; left: 0; width: 100%; top: 13px; height: 30px; }</style>',
      filename: 'test.vue',
    },
    // 垂直: top + bottom で両側指定
    {
      code: '<template><div></div></template><style scoped>.body { position: absolute; top: 70px; bottom: 25px; left: 25px; right: 25px; }</style>',
      filename: 'test.vue',
    },
    // 垂直: top + height で高さ指定
    {
      code: '<template><div></div></template><style scoped>.header { position: absolute; top: 20px; height: 40px; left: 25px; right: 25px; }</style>',
      filename: 'test.vue',
    },
    // inset で全方向指定
    {
      code: '<template><div></div></template><style scoped>.overlay { position: absolute; inset: 0; }</style>',
      filename: 'test.vue',
    },
    // position: relative は対象外
    {
      code: '<template><div></div></template><style scoped>.block { position: relative; left: 10px; top: 5px; }</style>',
      filename: 'test.vue',
    },
    // position: static は対象外
    {
      code: '<template><div></div></template><style scoped>.block { position: static; }</style>',
      filename: 'test.vue',
    },
    // position 指定なし
    {
      code: '<template><div></div></template><style scoped>.block { left: 0; top: 0; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // position: absolute のみ（left/topなし → shrink-wrapリスクなし）
    {
      code: '<template><div></div></template><style scoped>.block { position: absolute; }</style>',
      filename: 'test.vue',
    },
    // left + right（rightが0でなくても存在すればOK）
    {
      code: '<template><div></div></template><style scoped>.sidebar { position: absolute; left: 0; right: 50px; top: 0; bottom: 0; }</style>',
      filename: 'test.vue',
    },
    // 改善F: white-space: nowrap で水平shrink-wrapを除外
    {
      code: '<template><div></div></template><style scoped>.copyright { position: absolute; left: 753px; top: 0; height: 30px; white-space: nowrap; font-size: 7px; }</style>',
      filename: 'test.vue',
    },
    // 改善F: data-pptx-image属性を持つ要素のクラスはスキップ
    {
      code: `<template>
  <div data-pptx-image class="glow-container">
    <div class="glow-left"></div>
  </div>
</template>
<style scoped>
.glow-container { position: absolute; top: 20px; left: 0; }
</style>`,
      filename: 'test.vue',
    },
    // narrow（#686）: 垂直 shrink-wrap（top のみ・bottom/height なし）は valid へ緩和する。
    // 2.1.1 の rect 実寸計測で高さが 0 に潰れず、autoFit で吸収されるため折り返しリスクが無い。
    {
      code: '<template><div></div></template><style scoped>.label { position: absolute; top: 0; left: 0; right: 0; }</style>',
      filename: 'test.vue',
    },
    // narrow: white-space:pre も水平 wrap:false（折り返しなし）として valid
    {
      code: '<template><div></div></template><style scoped>.code { position: absolute; left: 10px; top: 0; height: 30px; white-space: pre; }</style>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // narrow 後も残す: 水平 shrink-wrap（left のみ・right/width なし）
    // wrap:true でフォント差再折り返しの残存リスク
    {
      code: '<template><div></div></template><style scoped>.title { position: absolute; left: 0; top: 13px; height: 30px; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'shrinkwrapHorizontal' }],
    },
    // 水平 shrink-wrap + 垂直 shrink-wrap でも水平のみ検出（垂直は narrow で valid）
    {
      code: '<template><div></div></template><style scoped>.floating { position: absolute; left: 0; top: 0; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'shrinkwrapHorizontal' }],
    },
    // position: fixed も水平検出
    {
      code: '<template><div></div></template><style scoped>.modal { position: fixed; left: 50px; top: 0; bottom: 0; }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'shrinkwrapHorizontal' }],
    },
    // 複数styleブロックで水平を複数検出（垂直は valid）
    {
      code: '<template><div></div></template><style>.a { position: absolute; left: 0; top: 0; height: 20px; }</style><style scoped>.b { position: absolute; left: 5px; top: 10px; height: 20px; }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'shrinkwrapHorizontal' },
        { messageId: 'shrinkwrapHorizontal' },
      ],
    },
  ],
});
