import { RuleTester } from 'eslint';
import noCrossLayerImport from '../lib/rules/no-cross-layer-import.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-cross-layer-import', noCrossLayerImport, {
  valid: [
    // L1 (Layouts) → L3 (Components): 許可
    {
      name: 'L1 の Layouts から L3 の Components を import すると、報告しない',
      code: "import SHeader from '../components/text/SHeader.vue';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L3 (Components) → L3 (Components): 同層、許可
    {
      name: 'L3 の Components から同じ層の Components を import すると、報告しない',
      code: "import LIcon from './LIcon.vue';",
      filename: '/home/user/project/theme/components/text/SHeader.vue',
    },
    // L1 → utils: 許可（アーキテクチャ外）
    {
      name: 'L1 から utils を import すると、報告しない',
      code: "import { formatDate } from '../utils/date.ts';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L1 → composables: 許可（アーキテクチャ外）
    {
      name: 'L1 から composables を import すると、報告しない',
      code: "import { useTheme } from '../composables/useTheme.ts';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L3 → utils: 許可
    {
      name: 'L3 から utils を import すると、報告しない',
      code: "import { resolveAssetPath } from '../utils/assetPath.ts';",
      filename: '/home/user/project/theme/components/PageHeader.vue',
    },
    // L3 → composables: 許可
    {
      name: 'L3 から composables を import すると、報告しない',
      code: "import { useTheme } from '../composables/useTheme.ts';",
      filename: '/home/user/project/theme/components/PageHeader.vue',
    },
    // 外部モジュール: 許可
    {
      name: '外部モジュールを import すると、報告しない',
      code: "import { ref } from 'vue';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // アーキテクチャ外のファイル: 検証対象外
    {
      name: 'アーキテクチャ外のファイルからの import は、検証せず報告しない',
      code: "import test from './test.ts';",
      filename: '/home/user/project/other/file.js',
    },
  ],

  invalid: [
    // L1 → L1: 明示禁止
    {
      name: 'L1 から L1 を import すると、報告する',
      code: "import other from './end.vue';",
      filename: '/home/user/project/theme/layouts/cover.vue',
      errors: [
        {
          messageId: 'l1ToL1',
          data: {
            fromName: 'Layouts',
            toName: 'Layouts',
          },
        },
      ],
    },
    // L3 → L1: 逆方向禁止
    {
      name: 'L3 から L1 を import すると、逆方向として報告する',
      code: "import Cover from '../layouts/cover.vue';",
      filename: '/home/user/project/theme/components/PageHeader.vue',
      errors: [
        {
          messageId: 'illegalImport',
          data: {
            fromLayer: 3,
            fromName: 'Components',
            toLayer: 1,
            toName: 'Layouts',
            allowed: 'Layer 3 (Components)',
          },
        },
      ],
    },
  ],
});
