import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import requireImageBorderRadius from '../lib/rules/require-image-border-radius.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run('require-image-border-radius', requireImageBorderRadius, {
  valid: [
    // imgにborder-radiusがある場合はOK
    {
      name: 'img に border-radius があると、報告しない',
      code: '<template><div class="image-block"><div class="image-area"><img style="border-radius: 8px" /></div></div></template>',
      filename: 'test.vue',
    },
    // imgが直接image-blockの子の場合はOK
    {
      name: 'img が image-block の直接の子だと、報告しない',
      code: '<template><div class="image-block"><img /></div></template>',
      filename: 'test.vue',
    },
    // imgがadaptive-imageの直接の子の場合はOK
    {
      name: 'img が adaptive-image の直接の子だと、報告しない',
      code: '<template><div class="adaptive-image"><img /></div></template>',
      filename: 'test.vue',
    },
    // 画像コンテナ系クラスがない場合はスキップ
    {
      name: '画像コンテナ系のクラスが無いと、報告しない',
      code: '<template><div class="wrapper"><div class="inner"><img /></div></div></template>',
      filename: 'test.vue',
    },
    // :style変数参照（静的解析困難）はOKとみなす
    {
      name: ':style が変数参照で静的に読めないと、報告しない',
      code: '<template><div class="image-block"><div class="image-area"><img :style="imageStyle" /></div></div></template>',
      filename: 'test.vue',
    },
    // :style ObjectExpressionにborderRadiusがある場合はOK
    {
      name: ':style のオブジェクトに borderRadius があると、報告しない',
      code: `<template><div class="image-block"><div class="image-area"><img :style="{ borderRadius: '8px' }" /></div></div></template>`,
      filename: 'test.vue',
    },
    // adaptive-image-wrapper > adaptive-image > img: 直接の子なのでOK（部分一致による誤検知の回帰テスト）
    {
      name: 'adaptive-image-wrapper の中の adaptive-image の直接の子なら、クラス名の部分一致で誤報告しない',
      code: '<template><div class="adaptive-image-wrapper"><div class="adaptive-image"><img /></div></div></template>',
      filename: 'test.vue',
    },
    // 複数クラスを持つ要素の直接の子
    {
      name: '複数のクラスを持つ要素の直接の子なら、報告しない',
      code: '<template><div class="image-block rounded"><img /></div></template>',
      filename: 'test.vue',
    },
  ],

  invalid: [
    // image-block内に中間要素があり、imgにborder-radiusがない
    {
      name: 'image-block との間に中間要素があり、img に border-radius が無いと、報告する',
      code: '<template><div class="image-block"><div class="image-area"><img /></div></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'requireImageBorderRadius' }],
    },
    // hero-image内に中間要素がある
    {
      name: 'hero-image との間に中間要素があり、img に border-radius が無いと、報告する',
      code: '<template><div class="hero-image"><div class="inner"><img /></div></div></template>',
      filename: 'test.vue',
      errors: [{ messageId: 'requireImageBorderRadius' }],
    },
    // :style ObjectExpressionにborderRadiusがない場合はNG
    {
      name: ':style のオブジェクトに borderRadius が無いと、報告する',
      code: `<template><div class="image-block"><div class="image-area"><img :style="{ objectFit: 'cover' }" /></div></div></template>`,
      filename: 'test.vue',
      errors: [{ messageId: 'requireImageBorderRadius' }],
    },
  ],
});
