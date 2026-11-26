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
    { name: 'layouts 直下に kebab-case の .vue を置くと、報告しない', code: 'export default {}', filename: `${P}/layouts/content.vue` },
    { name: 'layouts 直下に kebab-case でハイフンの多いファイル名を置くと、報告しない', code: 'export default {}', filename: `${P}/layouts/media-right-image.vue` },
    { name: 'layouts 直下に _ で始まるテンプレートのファイル名を置くと、報告しない', code: 'export default {}', filename: `${P}/layouts/_tpl-content.vue` },

    // L3: Components（PascalCase）
    { name: 'components 直下に PascalCase の .vue を置くと、報告しない', code: 'export default {}', filename: `${P}/components/PageHeader.vue` },
    { name: 'components 直下に単語 1 つの PascalCase の .vue を置くと、報告しない', code: 'export default {}', filename: `${P}/components/Button.vue` },
    { name: 'components の 3 段目に PascalCase の .vue を置くと、報告しない', code: 'export default {}', filename: `${P}/components/text/plain/LDescriptionText.vue` },
    { name: 'components の別の 3 段目に PascalCase の .vue を置くと、報告しない', code: 'export default {}', filename: `${P}/components/image/card/LHeroImage.vue` },

    // 対象外の拡張子（.vue / .js / .ts 以外。.css は別の判定）は配置を確認しない
    { name: '対象外の拡張子のファイルは、配置を確認せず報告しない', code: 'export default {}', filename: `${P}/misc/readme.md` },

    // アーキテクチャ外の既知ディレクトリ（スキップ対象）
    { name: 'アーキテクチャ外の既知のディレクトリ utils に置くと、報告しない', code: 'export default {}', filename: `${P}/utils/assetPath.js` },
    { name: 'アーキテクチャ外の既知のディレクトリ composables に置くと、報告しない', code: 'export default {}', filename: `${P}/composables/useTheme.js` },
    { name: 'アーキテクチャ外の既知のディレクトリ setup に置くと、報告しない', code: 'export default {}', filename: `${P}/setup/config.js` },
    { name: 'アーキテクチャ外の既知のディレクトリ pages に置くと、報告しない', code: 'export default {}', filename: `${P}/pages/index.vue` },
    { name: 'アーキテクチャ外の既知のディレクトリ styles に置くと、報告しない', code: 'export default {}', filename: `${P}/styles/index.ts` },
    { name: 'アーキテクチャ外の既知のディレクトリ public に置くと、報告しない', code: 'export default {}', filename: `${P}/public/assets/test.js` },

    // プロジェクト名に依存しない（presentationsでも動作）
    { name: 'プロジェクト名が presentations 配下でも、layouts の配置を満たすと報告しない', code: 'export default {}', filename: '/presentations/my-deck/layouts/cover.vue' },
    { name: 'プロジェクト名が presentations 配下でも、components の配置を満たすと報告しない', code: 'export default {}', filename: '/presentations/my-deck/components/text/STitle.vue' },
  ],

  invalid: [
    // 廃止された L2 配置: layouts/{layout}/*.vue
    {
      name: 'layouts の下にレイアウト名のディレクトリ content を作ると、報告する',
      code: 'export default {}',
      filename: `${P}/layouts/content/Header.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: 'content' } }],
    },
    {
      name: 'layouts の下にレイアウト名のディレクトリ cover を作ると、報告する',
      code: 'export default {}',
      filename: `${P}/layouts/cover/Hero.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: 'cover' } }],
    },
    {
      name: 'layouts の下に _shared ディレクトリを作ると、報告する',
      code: 'export default {}',
      filename: `${P}/layouts/_shared/Title.vue`,
      errors: [{ messageId: 'l2DirectoryForbidden', data: { subdir: '_shared' } }],
    },

    // L1: 誤った拡張子
    {
      name: 'layouts 直下に .vue 以外の拡張子のファイルを置くと、報告する',
      code: 'export default {}',
      filename: `${P}/layouts/content.js`,
      errors: [{ messageId: 'wrongExtension' }],
    },
    // L1: PascalCase（kebab-case必須）
    {
      name: 'layouts 直下に PascalCase の .vue を置くと、報告する',
      code: 'export default {}',
      filename: `${P}/layouts/Content.vue`,
      errors: [{ messageId: 'wrongNaming' }],
    },
    // L3 Components: kebab-case（PascalCase必須）
    {
      name: 'components 直下に kebab-case の .vue を置くと、報告する',
      code: 'export default {}',
      filename: `${P}/components/page-header.vue`,
      errors: [{ messageId: 'wrongNaming' }],
    },
    // 不明な場所（.vueファイル）
    {
      name: '認識できない場所に .vue を置くと、報告する',
      code: 'export default {}',
      filename: `${P}/test.vue`,
      errors: [{ messageId: 'unknownLocation' }],
    },
    // 不明な場所（src/は認識されない）
    {
      name: 'src/ の下に .vue を置くと、不明な場所として報告する',
      code: 'export default {}',
      filename: `${P}/src/containers/Header.vue`,
      errors: [{ messageId: 'unknownLocation' }],
    },
    // ネスト深度超過（components/は最大3段）
    {
      name: 'components の入れ子が 3 段を超えると、報告する',
      code: 'export default {}',
      filename: `${P}/components/a/b/c/d/Deep.vue`,
      errors: [{ messageId: 'deepNesting' }],
    },
  ],
});
