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
      name: 'セルがテキストだけなら、報告しない',
      code: '<template><table><tr><td>text</td></tr></table></template>',
      filename: 'test.vue',
    },
    // <span>は許可
    {
      name: 'セルの中が span なら、報告しない',
      code: '<template><table><tr><td><span>text</span></td></tr></table></template>',
      filename: 'test.vue',
    },
    // <strong>は許可
    {
      name: 'セルの中が strong なら、報告しない',
      code: '<template><table><tr><td><strong>bold</strong></td></tr></table></template>',
      filename: 'test.vue',
    },
    // テーブル外の<img>は対象外
    {
      name: 'テーブルの外の img なら、報告しない',
      code: '<template><div><img src="test.png" /></div></template>',
      filename: 'test.vue',
    },
    // テーブルセルがない場合
    {
      name: 'テーブルのセルが無ければ、報告しない',
      code: '<template><div>no table</div></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <td>内の<img>
    {
      name: 'td の中に img があると、報告する',
      code: '<template><table><tr><td><img src="test.png" /></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内の<svg>
    {
      name: 'td の中に svg があると、報告する',
      code: '<template><table><tr><td><svg><circle /></svg></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内の<canvas>
    {
      name: 'td の中に canvas があると、報告する',
      code: '<template><table><tr><td><canvas></canvas></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <td>内のネストされた<table>
    {
      name: 'td の中に table を入れ子にすると、報告する',
      code: '<template><table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <th>内の<img>
    {
      name: 'th の中に img があると、報告する',
      code: '<template><table><tr><th><img src="icon.png" /></th></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // <div>でラップされた<img>（間接的な子）
    {
      name: 'div で包んだ img がセルの中にあっても、報告する',
      code: '<template><table><tr><td><div><img src="test.png" /></div></td></tr></table></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noTableComplexContent' }],
    },
    // 複数の禁止要素
    {
      name: 'セルの中に禁止の要素が複数あると、すべて報告する',
      code: '<template><table><tr><td><img src="a.png" /><svg></svg></td></tr></table></template>',
      filename: 'test.vue',
      errors: [
        { messageId: 'noTableComplexContent' },
        { messageId: 'noTableComplexContent' },
      ],
    },
  ],
});
