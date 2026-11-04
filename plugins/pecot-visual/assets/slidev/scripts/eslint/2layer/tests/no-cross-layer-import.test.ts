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
      code: "import SHeader from '../components/text/SHeader.vue';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L3 (Components) → L3 (Components): 同層、許可
    {
      code: "import LIcon from './LIcon.vue';",
      filename: '/home/user/project/theme/components/text/SHeader.vue',
    },
    // L1 → utils: 許可（アーキテクチャ外）
    {
      code: "import { formatDate } from '../utils/date.ts';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L1 → composables: 許可（アーキテクチャ外）
    {
      code: "import { useTheme } from '../composables/useTheme.ts';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // L3 → utils: 許可
    {
      code: "import { resolveAssetPath } from '../utils/assetPath.ts';",
      filename: '/home/user/project/theme/components/PageHeader.vue',
    },
    // L3 → composables: 許可
    {
      code: "import { useTheme } from '../composables/useTheme.ts';",
      filename: '/home/user/project/theme/components/PageHeader.vue',
    },
    // 外部モジュール: 許可
    {
      code: "import { ref } from 'vue';",
      filename: '/home/user/project/theme/layouts/cover.vue',
    },
    // アーキテクチャ外のファイル: 検証対象外
    {
      code: "import test from './test.ts';",
      filename: '/home/user/project/other/file.js',
    },
  ],

  invalid: [
    // L1 → L1: 明示禁止
    {
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

console.log('All tests passed!');
