import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import requireResolveAssetPath from '../lib/rules/require-resolve-asset-path.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('require-resolve-asset-path', requireResolveAssetPath, {
  valid: [
    // resolveAssetPath()でラップ済み
    {
      code: `<template><div></div></template>
<script setup>
import { resolveAssetPath } from '../utils/assetPath.ts'
fetch(resolveAssetPath('/slides/data.json'))
</script>`,
      filename: 'test.vue',
    },
    // テーマの public/ を配る /theme/ も resolveAssetPath で包めば通る
    {
      code: `<template><div></div></template>
<script setup>
import { resolveAssetPath } from '../utils/assetPath.ts'
fetch(resolveAssetPath('/theme/x.json'))
</script>`,
      filename: 'test.vue',
    },
    // 外部URL（https）
    {
      code: `<template><div></div></template>
<script setup>
fetch('https://api.example.com/data')
</script>`,
      filename: 'test.vue',
    },
    // 外部URL（http）
    {
      code: `<template><div></div></template>
<script setup>
fetch('http://api.example.com/data')
</script>`,
      filename: 'test.vue',
    },
    // テンプレートリテラルの外部URL
    {
      code: '<template><div></div></template>\n<script setup>\nfetch(`https://api.example.com/${path}`)\n</script>',
      filename: 'test.vue',
    },
    // 引数なし
    {
      code: `<template><div></div></template>
<script setup>
fetch()
</script>`,
      filename: 'test.vue',
    },
    // fetch以外の関数呼び出し
    {
      code: `<template><div></div></template>
<script setup>
getData('/slides/data.json')
</script>`,
      filename: 'test.vue',
    },
  ],

  invalid: [
    // 文字列リテラルの相対パス
    {
      code: `<template><div></div></template>
<script setup>
fetch('data.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // 先頭が / でないテンプレートリテラル
    {
      code: `<template><div></div></template>
<script setup>
const name = 'a'
fetch(\`data/\${name}.json\`)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // 絶対パス直接渡し
    {
      code: `<template><div></div></template>
<script setup>
fetch('/slides/data.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // /theme/ 直接渡し（Pages の base の下で外れるため、/slides/ と同じく報告する）
    {
      code: `<template><div></div></template>
<script setup>
fetch('/theme/x.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // 変数渡し
    {
      code: `<template><div></div></template>
<script setup>
const url = getUrl()
fetch(url)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // プロパティアクセス
    {
      code: `<template><div></div></template>
<script setup>
fetch(props.xmlSrc)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // window.fetch + 絶対パス
    {
      code: `<template><div></div></template>
<script setup>
window.fetch('/assets/icon.svg')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // テンプレートリテラルで絶対パス
    {
      code: '<template><div></div></template>\n<script setup>\nfetch(`/slides/${name}/data.json`)\n</script>',
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // .value アクセス（computed等）
    {
      code: `<template><div></div></template>
<script setup>
fetch(resolvedIcon.value)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
  ],
});

console.log('All require-resolve-asset-path tests passed!');
