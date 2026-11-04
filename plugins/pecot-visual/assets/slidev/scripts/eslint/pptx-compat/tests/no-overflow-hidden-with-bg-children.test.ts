import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noOverflowHiddenWithBgChildren from '../lib/rules/no-overflow-hidden-with-bg-children.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run(
  'no-overflow-hidden-with-bg-children',
  noOverflowHiddenWithBgChildren,
  {
    valid: [
      // 1. 子要素にborder-radiusあり（インラインstyle）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5); border-radius: 8px"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 2. 子要素にborder-radiusあり（CSSクラス）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="overlay"></div>
  </div>
</template>
<style>
.overlay {
  background-color: rgba(0,0,0,0.5);
  border-radius: 8px;
}
</style>`,
        filename: 'test.vue',
      },
      // 3. 子要素にborder-radiusあり（:styleバインディング）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div :style="{ background: 'red', borderRadius: '8px' }"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 4. 子要素にbackgroundなし
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="no-bg"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 5. img要素はスキップ（require-image-border-radiusでカバー）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <img src="test.jpg" />
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 6. 親にoverflow:hiddenなし
      {
        code: `<template>
  <div style="border-radius: 8px">
    <div style="background: red"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 7. 親にborder-radiusなし
      {
        code: `<template>
  <div style="overflow: hidden">
    <div style="background: red"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 8. data-pptx-image祖先（スキップ）
      {
        code: `<template>
  <div data-pptx-image style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 9. 子要素の背景がtransparent（CSS）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="transparent-bg"></div>
  </div>
</template>
<style>
.transparent-bg {
  background: transparent;
}
</style>`,
        filename: 'test.vue',
      },
      // 10. 子要素の背景がtransparent（インライン）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: transparent"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 11. 子要素の背景がnone
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: none"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 12. 子要素の背景がrgba(0,0,0,0)
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background-color: rgba(0,0,0,0)"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 13. クラス名部分一致で誤検出しない
      {
        code: `<template>
  <div class="detail-card">
    <div class="detail-header"></div>
  </div>
</template>
<style>
.detail-card {
  border-radius: 8px;
  overflow: hidden;
}
.detail-header-line {
  background: #ccc;
}
</style>`,
        filename: 'test.vue',
      },
    ],

    invalid: [
      // 1. インラインstyle: 親overflow:hidden+border-radius、子background（テキストなし空div）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"></div>
  </div>
</template>`,
        filename: 'test.vue',
        errors: [{ messageId: 'noOverflowHiddenWithBgChildren' }],
      },
      // 2. CSSクラス: 親overflow:hidden+border-radius、子background-color（テキストなし空div）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="overlay"></div>
  </div>
</template>
<style>
.overlay {
  background-color: rgba(0,0,0,0.5);
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'noOverflowHiddenWithBgChildren' }],
      },
      // 3. 混合: 親:style border-radius+CSS overflow:hidden、子inline background
      {
        code: `<template>
  <div class="container" :style="{ borderRadius: '8px' }">
    <div style="background: rgba(0,0,0,0.5)"></div>
  </div>
</template>
<style>
.container {
  overflow: hidden;
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'noOverflowHiddenWithBgChildren' }],
      },
      // 4. 複合セレクタ: .caption-area.overlay-bottom パターン
      {
        code: `<template>
  <div class="image-block" style="overflow: hidden; border-radius: 8px">
    <div class="caption-area overlay-bottom"></div>
  </div>
</template>
<style>
.caption-area.overlay-bottom {
  background: rgba(0,0,0,0.6);
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'noOverflowHiddenWithBgChildren' }],
      },
      // 5. テキスト含有子要素+background（既存ルールとの重複検出）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
        errors: [{ messageId: 'noOverflowHiddenWithBgChildren' }],
      },
      // 6. MChatApp相当パターン: 親overflow:hidden+border-radius、子sidebar+背景
      {
        code: `<template>
  <div class="chat-app">
    <div class="sidebar"></div>
    <div class="main-content"><p>messages</p></div>
  </div>
</template>
<style>
.chat-app {
  overflow: hidden;
  border-radius: 16px;
}
.sidebar {
  background-color: #f0f0f0;
}
.main-content {
  background-color: #ffffff;
}
</style>`,
        filename: 'test.vue',
        errors: [
          { messageId: 'noOverflowHiddenWithBgChildren' },
          { messageId: 'noOverflowHiddenWithBgChildren' },
        ],
      },
    ],
  },
);

console.log(
  'All no-overflow-hidden-with-bg-children tests passed!',
);
