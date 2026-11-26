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
      name: 'border-left で実装すると、報告しない',
      code: '<template><div></div></template><style scoped>.card { border-left: 4px solid #1e3a8a; padding-left: 12px; }</style>',
      filename: 'test.vue',
    },
    // CSS border-topで実装（推奨パターン）
    {
      name: 'border-top で実装すると、報告しない',
      code: '<template><div></div></template><style scoped>.card { border-top: 3px solid #1e3a8a; padding-top: 8px; }</style>',
      filename: 'test.vue',
    },
    // position: absoluteだがwidth > 5px（装飾バーでない）
    {
      name: 'position: absolute でも width が 5px を超えると、報告しない',
      code: '<template><div></div></template><style scoped>.sidebar { position: absolute; width: 200px; height: 100%; left: 0; top: 0; }</style>',
      filename: 'test.vue',
    },
    // position: absoluteだがwidthが%指定
    {
      name: 'position: absolute でも width が % 指定だと、報告しない',
      code: '<template><div></div></template><style scoped>.bar { position: absolute; width: 50%; height: 100%; left: 0; top: 0; }</style>',
      filename: 'test.vue',
    },
    // position: relativeで小さいwidth
    {
      name: 'position: relative なら、width が小さくても報告しない',
      code: '<template><div></div></template><style scoped>.bar { position: relative; width: 4px; height: 100%; }</style>',
      filename: 'test.vue',
    },
    // position指定なしで小さいwidth
    {
      name: 'position の指定が無ければ、width が小さくても報告しない',
      code: '<template><div></div></template><style scoped>.bar { width: 4px; height: 100%; background-color: #1e3a8a; }</style>',
      filename: 'test.vue',
    },
    // styleブロックなし
    {
      name: 'style ブロックが無いと、報告しない',
      code: '<template><div></div></template>',
      filename: 'test.vue',
    },
    // width 6px（閾値境界: OK）
    {
      name: 'width がしきい値の 5px を 1 つ超える 6px なら、報告しない',
      code: '<template><div></div></template><style scoped>.bar { position: absolute; width: 6px; height: 100%; left: 0; top: 0; background-color: #1e3a8a; }</style>',
      filename: 'test.vue',
    },
    // 改善C: 親にoverflow:hiddenなし → 独立要素でOK（スキップ）
    {
      name: '親に overflow: hidden が無いと、報告しない',
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
      name: '装飾バーのセレクタに合う要素がテンプレートに無いと、報告しない',
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
      name: '親に overflow: hidden が無く、クラスで指定しても、報告しない',
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
      name: 'overflow: hidden の祖先に border-radius が無いと、報告しない',
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
      name: 'border-radius の祖先の配下に装飾バーのセレクタに合う要素が無いと、報告しない',
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
      name: '祖先の :style で borderRadius が数値の 0 だと、報告しない',
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
      name: '祖先の :style で borderRadius が \'0px\' だと、報告しない',
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
      name: '祖先の border-radius が 0pt だと、報告しない',
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
    {
      name: '祖先の :style に borderRadius 以外のキー・計算キー・スプレッドしか無いと、報告しない',
      code: `<template><div :style="{ color: c, [k]: 1, ...rest, 'margin-top': m }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の :style が変数だと、角丸と見なさず報告しない',
      code: `<template><div :style="styleVar"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の :style の borderRadius が文字列の 0 だと、報告しない',
      code: `<template><div :style="{ borderRadius: '0' }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の :style の borderRadius が none だと、報告しない',
      code: `<template><div :style="{ 'borderRadius': 'none' }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の :style の borderRadius が空文字だと、報告しない',
      code: `<template><div :style="{ borderRadius: '' }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の :style に値が無いと、報告しない',
      code: `<template><div :style><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先の border-radius が水平と垂直ともに 0 だと、報告しない',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 0 / 0px; }
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先のインライン style の border-radius が none だと、報告しない',
      code: `<template><div style="border-radius: none"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先のインライン style に border-radius が無いと、報告しない',
      code: `<template><div style="color: red"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '祖先に class と style が無いと、報告しない',
      code: `<template><div><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: 'バーのセレクタにクラスが無いと、どの要素にも合わず報告しない',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 8px; }
div { position: absolute; width: 3px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '装飾バーの幅と高さが 5px を超えると、報告しない',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 8px; }
.bar { position: absolute; width: 10px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: '装飾バーの幅と高さが auto だと、報告しない',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 8px; }
.bar { position: absolute; width: auto; height: auto; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: 'セレクタが別クラスの名前の前半と同じだけだと、その要素を装飾バーと見なさず報告しない',
      code: `<template><div class="c"><div class="bar-wide"></div></div></template>
<style scoped>
.c { border-radius: 8px; }
.bar { position: absolute; width: 3px; }
</style>`,
      filename: 'test.vue',
    },
    {
      name: 'クラスのあるルートでも、角丸の祖先が無く class が別のものなら、報告しない',
      code: `<template><div class="plain other"><div class="bar"></div></div></template>
<style scoped>
.plain { color: red; }
.other { border-radius: 0; }
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
    },
  ],

  invalid: [
    {
      name: '祖先の :style の borderRadius が 0 以外の数値だと、報告する',
      code: `<template><div :style="{ borderRadius: 8 }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先の :style の borderRadius が文字列の値を持つと、報告する',
      code: `<template><div :style="{ borderRadius: '8px 4px' }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先の :style の borderRadius が数値・文字列のリテラルでないと、角丸と見なして報告する',
      code: `<template><div :style="{ borderRadius: null }"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先の border-radius が calc() などの数値でない値だと、角丸と見なして報告する',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: calc(1px + 1px); }
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先の border-radius が 4 つの値のうち 1 つだけ 0 以外だと、報告する',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 0 0 0 6px; }
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先のインライン style の border-radius が var() だと、報告する',
      code: `<template><div style="border-radius: var(--r)"><div class="bar"></div></div></template>
<style scoped>
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '高さだけが 5px 以下のバーでも、角丸の祖先の中にあると報告する',
      code: `<template><div class="c"><div class="bar"></div></div></template>
<style scoped>
.c { border-radius: 8px; }
.bar { position: absolute; width: 100px; height: 2px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    {
      name: '祖先の :style に 0 の borderRadius があっても、より外の祖先が角丸なら報告する',
      code: `<template><section class="c"><div :style="{ borderRadius: 0 }"><div class="bar"></div></div></section></template>
<style scoped>
.c { border-radius: 8px; }
.bar { position: absolute; width: 3px; height: 10px; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'decorativeBarElement' }],
    },
    // narrow（#686）: 角丸（border-radius）祖先内の細バー → 報告（角丸侵食リスク）
    {
      name: 'border-radius の祖先の中に細いバーがあると、報告する',
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
      name: 'インライン style の border-radius を持つ祖先の中にバーがあると、報告する',
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
      name: 'border-radius の祖先が直接の親でなくても、報告する',
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
      name: 'border-radius の祖先の中にバーが複数あると、すべて報告する',
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
      name: '祖先の :style の borderRadius が変数だと、報告する',
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


// vue-eslint-parser 以外のパーサでは、CSS だけを見て装飾バーを全件報告する
const cssOnlyTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

cssOnlyTester.run('no-decorative-bar-element (CSS のみ)', noDecorativeBarElement, {
  valid: [
    {
      name: 'style ブロックに position の指定が無いと、報告しない',
      code: 'export default `<style>.bar { width: 3px; }</style>`;',
      filename: 'test.js',
    },
    {
      name: 'position が absolute でないと、報告しない',
      code: 'export default `<style>.bar { position: relative; width: 3px; }</style>`;',
      filename: 'test.js',
    },
    {
      name: 'absolute で幅と高さが 5px を超えると、報告しない',
      code: 'export default `<style>.bar { position: absolute; width: 20px; height: 20px; }</style>`;',
      filename: 'test.js',
    },
  ],
  invalid: [
    {
      name: 'absolute で幅が 5px 以下だと、角丸の祖先を問わず報告する',
      code: 'export default `<style>.bar { position: absolute; width: 3px; }</style>`;',
      filename: 'test.js',
      errors: [{ messageId: 'decorativeBarElement', data: { selector: '.bar' } }],
    },
    {
      name: 'absolute で高さが 5px 以下だと、報告する',
      code: 'export default `<style>.line { position: absolute; width: 100px; height: 2px; }</style>`;',
      filename: 'test.js',
      errors: [{ messageId: 'decorativeBarElement', data: { selector: '.line' } }],
    },
  ],
});
