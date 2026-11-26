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
      name: 'fetch の引数を resolveAssetPath() で包むと、報告しない',
      code: `<template><div></div></template>
<script setup>
import { resolveAssetPath } from '../utils/assetPath.ts'
fetch(resolveAssetPath('/slides/data.json'))
</script>`,
      filename: 'test.vue',
    },
    // テーマの public/ を配る /theme/ も resolveAssetPath で包めば通る
    {
      name: 'fetch の引数が /theme/ のパスでも resolveAssetPath() で包むと、報告しない',
      code: `<template><div></div></template>
<script setup>
import { resolveAssetPath } from '../utils/assetPath.ts'
fetch(resolveAssetPath('/theme/x.json'))
</script>`,
      filename: 'test.vue',
    },
    // 外部URL（https）
    {
      name: 'fetch の引数が https の外部 URL だと、報告しない',
      code: `<template><div></div></template>
<script setup>
fetch('https://api.example.com/data')
</script>`,
      filename: 'test.vue',
    },
    // 外部URL（http）
    {
      name: 'fetch の引数が http の外部 URL だと、報告しない',
      code: `<template><div></div></template>
<script setup>
fetch('http://api.example.com/data')
</script>`,
      filename: 'test.vue',
    },
    // テンプレートリテラルの外部URL
    {
      name: 'fetch の引数が外部 URL のテンプレートリテラルだと、報告しない',
      code: '<template><div></div></template>\n<script setup>\nfetch(`https://api.example.com/${path}`)\n</script>',
      filename: 'test.vue',
    },
    // 引数なし
    {
      name: 'fetch に引数が無いと、報告しない',
      code: `<template><div></div></template>
<script setup>
fetch()
</script>`,
      filename: 'test.vue',
    },
    // fetch以外の関数呼び出し
    {
      name: 'fetch 以外の関数に絶対パスを渡すと、報告しない',
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
      name: 'fetch に相対パスの文字列リテラルを渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
fetch('data.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // 先頭が / でないテンプレートリテラル
    {
      name: 'fetch に先頭が / でないテンプレートリテラルを渡すと、報告する',
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
      name: 'fetch に絶対パスを直接渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
fetch('/slides/data.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // /theme/ 直接渡し（Pages の base の下で外れるため、/slides/ と同じく報告する）
    {
      name: 'fetch に /theme/ のパスを直接渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
fetch('/theme/x.json')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // 変数渡し
    {
      name: 'fetch に変数を渡すと、報告する',
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
      name: 'fetch にプロパティアクセスを渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
fetch(props.xmlSrc)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
    // window.fetch + 絶対パス
    {
      name: 'window.fetch に絶対パスを渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
window.fetch('/assets/icon.svg')
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // テンプレートリテラルで絶対パス
    {
      name: 'fetch に絶対パスのテンプレートリテラルを渡すと、報告する',
      code: '<template><div></div></template>\n<script setup>\nfetch(`/slides/${name}/data.json`)\n</script>',
      filename: 'test.vue',
      errors: [{ messageId: 'absolutePathWithoutResolve' }],
    },
    // .value アクセス（computed等）
    {
      name: 'fetch に .value アクセスを渡すと、報告する',
      code: `<template><div></div></template>
<script setup>
fetch(resolvedIcon.value)
</script>`,
      filename: 'test.vue',
      errors: [{ messageId: 'missingResolveAssetPath' }],
    },
  ],
});
