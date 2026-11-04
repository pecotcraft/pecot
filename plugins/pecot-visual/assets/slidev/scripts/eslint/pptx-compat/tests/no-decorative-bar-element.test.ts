import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import noDecorativeBarElement from '../lib/rules/no-decorative-bar-element.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('no-decorative-bar-element', noDecorativeBarElement, {
  valid: [
    // CSS border-leftで実装（推奨パターン）
    {
      code: '<template><div></div></template><style scoped>.card { border-left: 4px solid #1e3a8a; padding-left: 12px; }</style>',
      filename: 'test.vue',
    },
    // CSS border-topで実装（推奨パターン）
    {
      code: '<template><div></div></template><style scoped>.card { border-top: 3px solid #1e3a8a; padding-top: 8px; }</style>',
      filename: 'test.vue',
    },
    // position: absoluteだがwidth > 5px（装飾バーでない）
    {
      code: '<template><div></div></template><style scoped>.sidebar { position: absolute; width: 200px; height: 100%; left: 0; top: 0; }</style>',
      filename: 'test.vue',
    },
    // position: absoluteだがwidthが%指定
    {
      code: '<template><div></div></template><style scoped>.bar { position: absolute; width: 50%; height: 100%; left: 0; top: 0; }</style>',
      filename: 'test.vue',
    },
    // position: relativeで小さいwidth
    {
      code: '<template><div></div></template><style scoped>.bar { position: relative; width: 4px; height: 100%; }</style>',
      filename: 'test.vue',
    },
    // position指定なしで小さいwidth
    {
      code: '<template><div></div></template><style scoped>.bar { width: 4px; height: 100%; background-color: #1e3a8a; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // width 6px（閾値境界: OK）
    {
      code: '<template><div></div></template><style scoped>.bar { position: absolute; width: 6px; height: 100%; left: 0; top: 0; background-color: #1e3a8a; }</style>',
      filename: 'test.vue',
    },
    // 改善C: 親にoverflow:hiddenなし → 独立要素でOK（スキップ）
    {
      code: `<template>
  <div class="wrapper">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.wrapper { position: relative; }
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
    // 改善C: テンプレートにマッチする要素がない装飾バーセレクタ → 報告なし
    {
      code: `<template>
  <div class="container">
    <div class="content"></div>
  </div>
</template>
<style scoped>
.bar-no-match { position: absolute; left: 0; top: 0; width: 4px; height: 100%; }
</style>`,
      filename: 'test.vue',
    },
    // 改善C: 親にoverflow:hiddenなし（CSSクラスでも確認）
    {
      code: `<template>
  <div class="section-heading-wrapper">
    <div class="section-heading-bar"></div>
    <h2 class="section-heading">Title</h2>
  </div>
</template>
<style scoped>
.section-heading-wrapper { position: relative; margin: 0 0 20px 0; }
.section-heading-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; }
</style>`,
      filename: 'test.vue',
    },
    // narrow（#686）: overflow:hidden 祖先だが border-radius が無い（角丸でない）→ 角侵食しないため valid
    {
      code: `<template>
  <div class="square-card">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.square-card { overflow: hidden; }
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
    // narrow 境界（#686, F-04）: border-radius 祖先は存在するが、その配下に
    // 装飾バーのセレクタに合う要素が無い。角を侵食する対象が不在のため、報告なし
    {
      code: `<template>
  <div class="rounded-card">
    <div class="content">Title</div>
  </div>
</template>
<style scoped>
.rounded-card { border-radius: 12px; overflow: hidden; }
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
    // F-01（#686）: :style バインディングで borderRadius がゼロリテラル（角丸でない）
    // → 角侵食しないため valid。キー存在のみでの false positive を防ぐ
    {
      code: `<template>
  <div :style="{ borderRadius: 0 }">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
    // F-01（#686）: :style の borderRadius がゼロ文字列リテラル（'0px'）→ valid
    {
      code: `<template>
  <div :style="{ borderRadius: '0px' }">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
    // F-02（#686）: border-radius: 0pt（未収録単位のゼロ値）祖先内のバー
    // → 数値解析で 0 と判定し角丸でないため valid
    {
      code: `<template>
  <div class="zero-pt-card">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.zero-pt-card { border-radius: 0pt; }
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
    },
  ],

  invalid: [
    // narrow（#686）: 角丸（border-radius）祖先内の細バー → 報告（角丸侵食リスク）
    {
      code: `<template>
  <div class="container">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.container { border-radius: 12px; overflow: hidden; }
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    // narrow: インラインstyleで border-radius を持つ角丸祖先
    {
      code: `<template>
  <div style="border-radius: 8px; overflow: hidden">
    <div class="top-bar"></div>
  </div>
</template>
<style scoped>
.top-bar { position: absolute; left: 0; top: 0; width: 100%; height: 3px; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    // narrow: 角丸祖先（直接の親でなくても検出）
    {
      code: `<template>
  <div class="outer">
    <div class="inner">
      <div class="divider"></div>
    </div>
  </div>
</template>
<style scoped>
.outer { border-radius: 16px; }
.inner { position: relative; }
.divider { position: absolute; right: 0; top: 0; width: 1px; height: 100%; background-color: #e5e7eb; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    // narrow: 複数バー要素、角丸祖先 → 全て報告
    {
      code: `<template>
  <div class="card">
    <div class="left-bar"></div>
    <div class="top-bar"></div>
  </div>
</template>
<style scoped>
.card { border-radius: 12px; }
.left-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
.top-bar { position: absolute; left: 0; top: 0; width: 100%; height: 2px; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
      errors: [
        { messageId: 'decorativeBarElement' },
        { messageId: 'decorativeBarElement' },
      ],
    },
    // F-01（#686）: :style の borderRadius が変数参照（静的解析不可）→ 保守側に倒して報告（現挙動維持）
    {
      code: `<template>
  <div :style="{ borderRadius: radius }">
    <div class="accent-bar"></div>
  </div>
</template>
<style scoped>
.accent-bar { position: absolute; left: 0; top: 0; width: 4px; height: 100%; background-color: #1e3a8a; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
  ],
});

console.log('All no-decorative-bar-element tests passed!');
