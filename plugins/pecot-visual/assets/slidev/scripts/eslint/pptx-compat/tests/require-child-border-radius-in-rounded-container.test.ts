import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import requireChildBorderRadiusInRoundedContainer from '../lib/rules/require-child-border-radius-in-rounded-container.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run(
  'require-child-border-radius-in-rounded-container',
  requireChildBorderRadiusInRoundedContainer,
  {
    valid: [
      // 1. 子要素にborder-radiusあり（インラインstyle）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5); border-radius: 8px"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 2. 子要素にborder-radiusあり（CSSクラス）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="overlay"><p>text</p></div>
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
      // 3. 子要素にborder-radiusあり（:style）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div :style="{ background: 'red', borderRadius: '8px' }"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 4. 子要素にbackgroundなし
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="no-bg"><p>text</p></div>
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
    <div style="background: red"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 7. クラス名の部分一致でfalse positiveしない（.detail-header ≠ .detail-header-line）
      {
        code: `<template>
  <div class="detail-card">
    <div class="detail-header"><p>title</p></div>
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
      // 8. 親にborder-radiusなし
      {
        code: `<template>
  <div style="overflow: hidden">
    <div style="background: red"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 9. 改善D: テキストなし子要素（画像のみdiv）→ 安全（SVG化してもテキスト消失しない）
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 10. 改善D: テキストなし子要素（imgのみ含むdiv）→ 安全
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.6)"><img src="test.jpg" /></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
      // 11. 改善D: data-pptx-image属性を持つ要素→スキップ（Phase 1のガード）
      {
        code: `<template>
  <div data-pptx-image style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
      },
    ],

    invalid: [
      // 1. インラインstyle: 親overflow:hidden+border-radius → 子background+border-radiusなし
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div style="background: rgba(0,0,0,0.5)"><p>text</p></div>
  </div>
</template>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireChildBorderRadius' }],
      },
      // 2. CSSクラス: 親overflow:hidden+border-radius → 子background-color+border-radiusなし
      {
        code: `<template>
  <div style="overflow: hidden; border-radius: 8px">
    <div class="overlay"><p>text</p></div>
  </div>
</template>
<style>
.overlay {
  background-color: rgba(0,0,0,0.5);
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireChildBorderRadius' }],
      },
      // 3. :style+CSS混合: 親:style border-radius+CSS overflow:hidden → 子background+border-radiusなし
      {
        code: `<template>
  <div class="container" :style="{ borderRadius: '8px' }">
    <div style="background: rgba(0,0,0,0.5)"><p>text</p></div>
  </div>
</template>
<style>
.container {
  overflow: hidden;
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireChildBorderRadius' }],
      },
      // 4. 複合セレクタ: .caption-area.overlay-bottom パターン
      {
        code: `<template>
  <div class="image-block" style="overflow: hidden; border-radius: 8px">
    <div class="caption-area overlay-bottom"><p>caption</p></div>
  </div>
</template>
<style>
.caption-area.overlay-bottom {
  background: rgba(0,0,0,0.6);
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireChildBorderRadius' }],
      },
      // 5. LVisualCard相当: 動的border-radius親 + CSSクラス背景子
      {
        code: `<template>
  <div class="visual-card" :style="{ borderRadius: borderRadius + 'px' }">
    <div class="overlay"><p>text</p></div>
  </div>
</template>
<style>
.visual-card {
  overflow: hidden;
}
.overlay {
  background-color: rgba(0,0,66,0.85);
}
</style>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireChildBorderRadius' }],
      },
    ],
  },
);

console.log(
  'All require-child-border-radius-in-rounded-container tests passed!',
);
