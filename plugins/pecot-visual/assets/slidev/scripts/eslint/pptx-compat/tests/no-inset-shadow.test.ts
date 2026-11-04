import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noInsetShadow from '../lib/rules/no-inset-shadow.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-inset-shadow', noInsetShadow, {
  valid: [
    // 外部シャドウは問題なし
    {
      code: '<template><div></div></template><style scoped>.box { box-shadow: 0 2px 4px rgba(0,0,0,0.1); }</style>',
      filename: 'test.vue',
    },
    // box-shadowなし
    {
      code: '<template><div></div></template><style scoped>.box { border: 1px solid #ccc; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // text-shadowは対象外
    {
      code: '<template><div></div></template><style scoped>.box { text-shadow: 0 1px 2px #000; }</style>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // insetシャドウ
    {
      code: '<template><div></div></template><style scoped>.box { box-shadow: inset 0 2px 4px rgba(0,0,0,0.1); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noInsetShadow' }],
    },
    // 複合シャドウにinset含む
    {
      code: '<template><div></div></template><style scoped>.box { box-shadow: 0 2px 4px rgba(0,0,0,0.1), inset 0 1px 2px rgba(0,0,0,0.05); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noInsetShadow' }],
    },
    // 複数のstyleブロック
    {
      code: '<template><div></div></template><style>.a { box-shadow: inset 0 0 5px #000; }</style><style scoped>.b { box-shadow: inset 0 0 3px #000; }</style>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noInsetShadow' },
        { messageId: 'noInsetShadow' },
      ],
    },
    // 大文字 INSET（CSS は大小文字を区別しない）
    {
      code: '<template><div></div></template><style scoped>.box { box-shadow: INSET 0 2px 4px rgba(0,0,0,0.1); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noInsetShadow' }],
    },
    // 混在ケース Inset
    {
      code: '<template><div></div></template><style scoped>.box { box-shadow: Inset 0 2px 4px rgba(0,0,0,0.1); }</style>',
      filename: 'test.vue',
      errors: [{ messageId: 'noInsetShadow' }],
    },
  ],
});

console.log('All no-inset-shadow tests passed!');
