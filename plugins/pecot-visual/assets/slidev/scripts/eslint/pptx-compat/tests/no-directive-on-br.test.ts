import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noDirectiveOnBr from '../lib/rules/no-directive-on-br.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-directive-on-br', noDirectiveOnBr, {
  valid: [
    // 素の<br>はOK
    {
      code: '<template><p>line1<br />line2</p></template>',
      filename: 'test.vue',
    },
    // <br>なし（他要素にv-showがあるのは対象外）
    {
      code: '<template><p v-show="show">text</p></template>',
      filename: 'test.vue',
    },
    // <br>にclass属性（ディレクティブではない）はOK
    {
      code: '<template><p>text<br class="spacer" />more</p></template>',
      filename: 'test.vue',
    },
    // 他要素にv-ifは対象外
    {
      code: '<template><div><span v-if="show">text</span></div></template>',
      filename: 'test.vue',
    },
    // <br v-if>: Vue のコンパイルで DOM から消える。
    // 2.1.1 の変換結果は、br 無し・素の br と同一（#1178 計測）
    {
      code: '<template><p>{{ title }}<br v-if="title2" />{{ title2 }}</p></template>',
      filename: 'test.vue',
    },
    // <br :class>（v-bind shorthand）: 素の br と同一の出力
    {
      code: '<template><p>text<br :class="cls" />more</p></template>',
      filename: 'test.vue',
    },
    // <br v-bind:id>
    {
      code: '<template><p>text<br v-bind:id="myId" />more</p></template>',
      filename: 'test.vue',
    },
    // <h1>内の<br v-if>
    {
      code: '<template><h1>{{ title }}<br v-if="title2" />{{ title2 }}</h1></template>',
      filename: 'test.vue',
    },
    // dom-to-pptx の inline タグ一覧にある要素の v-show は、非表示でも safe inline のため段落は分割されない
    {
      code: '<template><p>A <span v-show="visible">x</span> B</p></template>',
      filename: 'test.vue',
    },
    {
      code: '<template><p>A <strong v-show="visible">x</strong> B</p></template>',
      filename: 'test.vue',
    },
    // 再現対象の要素でも v-if は DOM から消えるため対象外
    {
      code: '<template><p>A <code v-if="visible">x</code> B</p></template>',
      filename: 'test.vue',
    },
    // 再現対象の要素に v-show 以外のディレクティブは対象外
    {
      code: '<template><p>A <sup :class="cls">x</sup> B</p></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // <br v-show>
    {
      code: '<template><p>text<br v-show="visible" />more</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnBr' }],
    },
    // <h1>内の<br v-show>（親要素を問わない）
    {
      code: '<template><h1>{{ title }}<br v-show="title2" />{{ title2 }}</h1></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnBr' }],
    },
    // v-show と他ディレクティブの併用（v-show 以外が先に並んでも検出）
    {
      code: '<template><p>text<br :class="cls" v-show="visible" />more</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnBr' }],
    },
    // <code v-show>（#1178 計測: 1 sp → 2 sp）
    {
      code: '<template><p>A <code v-show="visible">x</code> B</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnInlineBreaker', data: { tag: 'code' } }],
    },
    // <sup v-show>（#1178 計測: 1 sp → 2 sp）
    {
      code: '<template><p>A <sup v-show="visible">x</sup> B</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnInlineBreaker', data: { tag: 'sup' } }],
    },
    // <sub v-show>（#1178 計測: 1 sp → 2 sp）
    {
      code: '<template><p>A <sub v-show="visible">x</sub> B</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnInlineBreaker', data: { tag: 'sub' } }],
    },
    // <u v-show>（#1178 計測: 1 sp → 2 sp）
    {
      code: '<template><p>A <u v-show="visible">x</u> B</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnInlineBreaker', data: { tag: 'u' } }],
    },
    // <s v-show>（#1178 計測: 1 sp → 2 sp）
    {
      code: '<template><p>A <s v-show="visible">x</s> B</p></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'noVShowOnInlineBreaker', data: { tag: 's' } }],
    },
  ],
});

console.log('All no-directive-on-br tests passed!');
