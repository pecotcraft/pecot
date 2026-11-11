import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import { configs as tsConfigs } from 'typescript-eslint'
import { importX } from 'eslint-plugin-import-x'
import unusedImports from 'eslint-plugin-unused-imports'
import promise from 'eslint-plugin-promise'
import n from 'eslint-plugin-n'
import unicorn from 'eslint-plugin-unicorn'
import { configs as regexpConfigs } from 'eslint-plugin-regexp'
import security from 'eslint-plugin-security'
import vitest from '@vitest/eslint-plugin'
import stylistic from '@stylistic/eslint-plugin'
import path from 'node:path'
import { describeTitleConfig } from '../../../libs/interface-spec/src/eslint/describe-title.ts'

const JA = String.raw`[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]`
const NO_JA = '題に日本語が無い（.claude/rules/test-conventions.md）'
const KUTEN = '題が句点で終わる（.claude/rules/test-conventions.md）'

const baseRestrictedSyntax = [
  { selector: 'TSEnumDeclaration', message: 'enum 禁止: const オブジェクト + as const か discriminated union を使う' },
  { selector: 'TSModuleDeclaration', message: 'namespace 禁止: ESM モジュールを使う' },
  { selector: 'TSAsExpression', message: 'as キャスト禁止: satisfies か型ガードを使う。unknown から絞り込む場合は、説明を付けて eslint-disable-next-line を使う。' },
]

// stdout・stderr への直接の書き込みを止める。行は src/diagnostics.ts の関数を通す。
const outputWriteMessage = 'stdout・stderr へ直接書かない: src/diagnostics.ts の createDiagnostics・writeData・passthrough を使う'
const outputWriteSyntax = [
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.property.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
]

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tsConfigs.strictTypeChecked,
  ...tsConfigs.stylisticTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  promise.configs['flat/recommended'],
  n.configs['flat/recommended'],
  unicorn.configs.recommended,
  regexpConfigs['flat/recommended'],
  security.configs.recommended,
  stylistic.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'vitest.e2e.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-readonly-parameter-types': ['error', {
        ignoreInferredTypes: true,
        treatMethodsAsReadonly: true,
      }],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
        'minimumDescriptionLength': 10,
      }],
      'unicorn/no-null': 'error',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
      'unused-imports/no-unused-imports': 'error',
      // DDD レイヤ依存方向: domain ← infra ← mcp の一方向のみ許す。
      'import-x/no-restricted-paths': ['error', {
        zones: [
          { target: './src/domain', from: './src/infra', message: 'domain から infra への import 禁止 (依存方向違反)' },
          { target: './src/domain', from: './src/mcp', message: 'domain から mcp への import 禁止 (依存方向違反)' },
          { target: './src/infra', from: './src/mcp', message: 'infra から mcp への import 禁止 (依存方向違反)' },
        ],
      }],
    },
  },
  {
    // flat config は options 付きの同じ規則を丸ごと置き換えるので、既存の配列と合わせて置く。
    files: ['src/**/*.ts'],
    ignores: ['src/diagnostics.ts', 'src/**/tests/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax, ...outputWriteSyntax],
    },
  },
  {
    files: ['src/**/tests/**/*.ts', '**/*.test.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/valid-title': [
        'error',
        {
          mustMatch: { it: [JA, NO_JA], test: [JA, NO_JA] },
          mustNotMatch: { it: ['。$', KUTEN], test: ['。$', KUTEN] },
        },
      ],
    },
  },
  {
    // co-located test は production import 制約の対象外。
    files: ['src/**/tests/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': 'off',
    },
  },
  // tests/interface/ のいちばん外の describe の題が、定義書の name にあるかを確かめる。
  // 規則は libs/interface-spec/src/eslint/describe-title.ts にある。
  describeTitleConfig([path.resolve(import.meta.dirname, '../interface/generated.json')]),
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tsConfigs.disableTypeChecked,
  },
)
