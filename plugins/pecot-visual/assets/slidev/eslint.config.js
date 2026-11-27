// 注: package.json の lint script は `.` ではなく `scripts` を明示する。
// ルート直下の `eslint.config.js` 自身や `tsconfig.*` を lint 対象に含めないため。
import fs from 'node:fs'
import path from 'node:path'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'
import vitest from '@vitest/eslint-plugin'
import { describeTitleConfig } from '../../../../libs/interface-spec/src/eslint/describe-title.ts'
import { tableKeyConfig } from '../../../../libs/interface-spec/src/eslint/table-key.ts'
import { testDescriptionConfig } from '../../../../libs/interface-spec/src/eslint/test-description.ts'
import { defineDeckLintConfig } from './deck-lint.config.js'

const tsFiles = ['scripts/**/*.ts']
const testFiles = ['scripts/**/*.test.ts']
const JA = String.raw`[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]`
const NO_JA = '題に日本語が無い（.claude/rules/test-conventions.md）'
const KUTEN = '題が句点で終わる（.claude/rules/test-conventions.md）'
// 規則テスト用の fixture deck。デッキ lint の規則を、配布先のデッキと同じ設定で当てる。
const deckRoot = path.join(import.meta.dirname, 'scripts/eslint/_shared/tests/fixtures/deck')
// デッキ lint は、CLI の `slide theme` と同じ 4 項目を、fixture deck の宣言から組んで渡す。
// 宣言の解釈はここで複製しない（読むのは 4 項目だけ）。
const declaration = JSON.parse(fs.readFileSync(path.join(deckRoot, 'pecot-theme.json'), 'utf8'))
const deckConfig = defineDeckLintConfig({
  referencesDirectories: [path.join(deckRoot, declaration.layouts.references)],
  panels: declaration.drawio.panels,
  markerLayouts: declaration.drawio.markerLayouts,
  rules: declaration.lint.rules,
})

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      // tsc -b 生成物は dist/ 配下に集約（lint 対象外）
      'scripts/**/dist/**',
    ],
  },
  { ...js.configs.recommended, files: ['**/*.{js,mjs,cjs}'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: tsFiles,
    // テストは projectService の tsconfig に入らないので、型の情報を使う規則から外す（下のブロックで当てる）
    ignores: testFiles,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: testFiles,
    extends: [...tseslint.configs.recommended],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // node:assert と、assertClose のような assert で始まる補助関数を、確かめとして数える。
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'assert', 'assert*'] }],
      'vitest/valid-title': [
        'error',
        {
          mustMatch: { it: [JA, NO_JA], test: [JA, NO_JA] },
          mustNotMatch: { it: ['。$', KUTEN], test: ['。$', KUTEN] },
        },
      ],
    },
  },
  // slidev は定義書を持たないので、tests/interface/ に describe を足すと、どの題も止まる。
  describeTitleConfig([]),
  tableKeyConfig(testFiles),
  testDescriptionConfig(testFiles),
  { ...prettierConfig, files: ['**/*.{js,mjs,cjs}', ...tsFiles] },
  {
    // fixture deck の pages/*.md と slides.md を、配布先のデッキと同じ規則で守る。
    // basePath を絶対パスにするのは、--config を指定すると、相対 basePath の基準が cwd になるため。
    basePath: deckRoot,
    extends: [deckConfig],
  },
)
