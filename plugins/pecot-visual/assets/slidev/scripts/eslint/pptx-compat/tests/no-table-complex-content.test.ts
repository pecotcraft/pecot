import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noTableComplexContent from '../lib/rules/no-table-complex-content.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-table-complex-content', noTableComplexContent, {
  valid: [
    // テキストのみ
    {
      code: '<template><table><tr><td>text</td></tr></table></template>',
      filename: 'test.vue',
    },
    // <span>は許可
    {
      code: '<template><table><tr><td><span>text</span></td></tr></table></template>',
      filename: 'test.vue',
    },
    // <strong>は許可
    {
      code: '<template><table><tr><td><strong>bold</strong></td></tr></table></template>',
      filename: 'test.vue',
    },
    // テーブル外の<img>は対象外
    {
      code: '<template><div><img src="test.png" /></div></template>',
      filename: 'test.vue',
    },
    // テーブルセルがない場合
    {
      code: '<template><div>no table</div></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <td>内の<img>
    {
      code: '<template><table><tr><td><img src="test.png" /></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内の<svg>
    {
      code: '<template><table><tr><td><svg><circle /></svg></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内の<canvas>
    {
      code: '<template><table><tr><td><canvas></canvas></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内のネストされた<table>
    {
      code: '<template><table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <th>内の<img>
    {
      code: '<template><table><tr><th><img src="icon.png" /></th></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <div>でラップされた<img>（間接的な子）
    {
      code: '<template><table><tr><td><div><img src="test.png" /></div></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // 複数の禁止要素
    {
      code: '<template><table><tr><td><img src="a.png" /><svg></svg></td></tr></table></template>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noTableComplexContent' },
        { messageId: 'noTableComplexContent' },
      ],
    },
  ],
});

console.log('All no-table-complex-content tests passed!');
