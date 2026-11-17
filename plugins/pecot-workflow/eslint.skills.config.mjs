// スキルの scripts/*.cjs の lint。ESLint は設定のディレクトリの外を見ないので、cli の設定をここから当てる。
// 打ち方は scripts/ci/run-lint.sh（プラグインのルートで --config に渡す）
import { defineConfig } from 'eslint/config'

import cli from './cli/eslint.config.js'

export default defineConfig({
  basePath: 'skills',
  extends: [cli],
  rules: {
    // エージェントが node で動かす CommonJS の CLI なので、require と終了コードを使う
    '@typescript-eslint/no-require-imports': 'off',
    'n/no-process-exit': 'off',
    'unicorn/no-process-exit': 'off',
    'unicorn/prefer-module': 'off',
    // 読むのはカレントリポ・兄弟リポ・配信の起点で、パスは引数と git から決まる
    'security/detect-non-literal-fs-filename': 'off',
  },
})
