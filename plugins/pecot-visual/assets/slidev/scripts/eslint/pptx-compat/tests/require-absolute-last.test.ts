import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import requireAbsoluteLast from '../lib/rules/require-absolute-last.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('require-absolute-last', requireAbsoluteLast, {
  valid: [
    // absolute要素が末尾: OK
    {
      code: `<template>
  <div class="card">
    <div class="body">Content</div>
    <p class="badge">POINT</p>
  </div>
</template>
<style scoped>
.card { position: relative; }
.badge { position: absolute; top: -8px; left: 0; }
</style>`,
      filename: 'test.vue',
    },
    // absolute要素なし: OK
    {
      code: `<template>
  <div class="card">
    <div class="body">Content</div>
    <p class="footer">Footer</p>
  </div>
</template>
<style scoped>
.card { position: relative; }
.body { display: flex; }
</style>`,
      filename: 'test.vue',
    },
    // 複数のabsolute要素が末尾にまとめられている: OK
    {
      code: `<template>
  <div class="card">
    <div class="body">Content</div>
    <p class="badge-a">A</p>
    <p class="badge-b">B</p>
  </div>
</template>
<style scoped>
.badge-a { position: absolute; top: 0; }
.badge-b { position: absolute; bottom: 0; }
</style>`,
      filename: 'test.vue',
    },
    // styleブロックなし: OK
    {
      code: '<template><div><p>Text</p></div></template>',
      filename: 'test.vue',
    },
    // absolute要素のみ（非absolute兄弟なし）: OK
    {
      code: `<template>
  <div class="wrapper">
    <p class="overlay">Overlay</p>
  </div>
</template>
<style scoped>
.overlay { position: absolute; top: 0; }
</style>`,
      filename: 'test.vue',
    },
    // position: relativeは対象外: OK
    {
      code: `<template>
  <div class="wrapper">
    <p class="rel">First</p>
    <div class="body">Body</div>
  </div>
</template>
<style scoped>
.rel { position: relative; }
</style>`,
      filename: 'test.vue',
    },
    // Vueコンポーネント（PascalCase）は positioning が判定不能のため透過する（OK）。
    // SHeader/SFooter は L3 内部で position:absolute を持つ。
    // absolute 兄弟（.body-container）の前後どちらにあっても、false positive にしない。
    {
      code: `<template>
  <div class="canvas">
    <SHeader />
    <div class="body-container">Body</div>
    <SFooter />
  </div>
</template>
<style scoped>
.body-container { position: absolute; top: 50px; }
</style>`,
      filename: 'test.vue',
    },
    // <slot> も透過: OK
    {
      code: `<template>
  <div class="wrapper">
    <slot name="title" />
    <div class="content">Content</div>
  </div>
</template>
<style scoped>
.content { position: absolute; top: 0; }
</style>`,
      filename: 'test.vue',
    },
  ],
  invalid: [
    // absolute要素が非absolute兄弟より前: NG
    {
      code: `<template>
  <div class="card">
    <p class="badge">POINT</p>
    <div class="body">Content</div>
  </div>
</template>
<style scoped>
.card { position: relative; }
.badge { position: absolute; top: -8px; left: 0; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absoluteBeforeSibling' }],
    },
    // ネストされた構造でも検出
    {
      code: `<template>
  <div class="outer">
    <div class="inner">
      <span class="overlay">X</span>
      <p class="text">Text</p>
    </div>
  </div>
</template>
<style scoped>
.overlay { position: absolute; top: 0; right: 0; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absoluteBeforeSibling' }],
    },
    // 複数のabsolute要素のうち1つが非absoluteの前にある
    {
      code: `<template>
  <div class="card">
    <p class="badge-top">TOP</p>
    <div class="body">Content</div>
    <p class="badge-bottom">BOTTOM</p>
  </div>
</template>
<style scoped>
.badge-top { position: absolute; top: 0; }
.badge-bottom { position: absolute; bottom: 0; }
</style>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absoluteBeforeSibling' }],
    },
  ],
});
