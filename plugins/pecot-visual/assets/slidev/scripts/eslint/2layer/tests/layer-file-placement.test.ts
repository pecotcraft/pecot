import { RuleTester } from 'eslint';
import layerFilePlacement from '../lib/rules/layer-file-placement.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

const P = '/any/project';

ruleTester.run('layer-file-placement', layerFilePlacement, {
  valid: [
    // L1: Layouts（kebab-case, depth=1）
    { code: 'export default {}', filename: `${P}/layouts/content.vue` },
    { code: 'export default {}', filename: `${P}/layouts/media-right-image.vue` },
    { code: 'export default {}', filename: `${P}/layouts/_tpl-content.vue` },

    // L3: Components（PascalCase）
    { code: 'export default {}', filename: `${P}/components/PageHeader.vue` },
    { code: 'export default {}', filename: `${P}/components/Button.vue` },
    { code: 'export default {}', filename: `${P}/components/text/plain/LDescriptionText.vue` },
    { code: 'export default {}', filename: `${P}/components/image/card/LHeroImage.vue` },

    // 対象外の拡張子（.vue / .js / .ts 以外。.css は別の判定）は配置を確認しない
    { code: 'export default {}', filename: `${P}/misc/readme.md` },

    // アーキテクチャ外の既知ディレクトリ（スキップ対象）
    { code: 'export default {}', filename: `${P}/utils/assetPath.js` },
    { code: 'export default {}', filename: `${P}/composables/useTheme.js` },
    { code: 'export default {}', filename: `${P}/setup/config.js` },
    { code: 'export default {}', filename: `${P}/pages/index.vue` },
    { code: 'export default {}', filename: `${P}/styles/index.ts` },
    { code: 'export default {}', filename: `${P}/public/assets/test.js` },

    // プロジェクト名に依存しない（presentationsでも動作）
    { code: 'export default {}', filename: '/presentations/my-deck/layouts/cover.vue' },
    { code: 'export default {}', filename: '/presentations/my-deck/components/text/STitle.vue' },
  ],

  invalid: [
    // 廃止された L2 配置: layouts/{layout}/*.vue
    {
      code: 'export default {}',
      filename: `${P}/layouts/content/Header.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: 'content' } }],
    },
    {
      code: 'export default {}',
      filename: `${P}/layouts/cover/Hero.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: 'cover' } }],
    },
    {
      code: 'export default {}',
      filename: `${P}/layouts/_shared/Title.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: '_shared' } }],
    },

    // L1: 誤った拡張子
    {
      code: 'export default {}',
      filename: `${P}/layouts/content.js`,
      errors: [{ messageId: 'wrongExtension' }],
    },
    // L1: PascalCase（kebab-case必須）
    {
      code: 'export default {}',
      filename: `${P}/layouts/Content.vue`,
      errors: [{ messageId: 'wrongNaming' }],
    },
    // L3 Components: kebab-case（PascalCase必須）
    {
      code: 'export default {}',
      filename: `${P}/components/page-header.vue`,
      errors: [{ messageId: 'wrongNaming' }],
    },
    // 不明な場所（.vueファイル）
    {
      code: 'export default {}',
      filename: `${P}/test.vue`,
      errors: [{ messageId: 'unknownLocation' }],
    },
    // 不明な場所（src/は認識されない）
    {
      code: 'export default {}',
      filename: `${P}/src/containers/Header.vue`,
      errors: [{ messageId: 'unknownLocation' }],
    },
    // ネスト深度超過（components/は最大3段）
    {
      code: 'export default {}',
      filename: `${P}/components/a/b/c/d/Deep.vue`,
      errors: [{ messageId: 'deepNesting' }],
    },
  ],
});

console.log('All tests passed!');
