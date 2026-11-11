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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
      // OOXML の名前空間とリレーションシップ種別の URI は、ECMA-376 が http で定める識別子。
      // 文字列の一致で判定されるため、https にはできない。
      // 上流の除外一覧には OOXML が無い。
      'unicorn/prefer-https': ['error', { ignore: [/^http:\/\/schemas\.(openxmlformats\.org|microsoft\.com\/office)\//] }],
      // `dev` は本パッケージの語彙。MCP ツール名 `slide_dev` と、Slidev / Vite 自身が
      // 「dev サーバ」と呼ぶ対象がそのまま識別子・ファイル名に出るため、この置換だけ外す。
      'unicorn/name-replacements': ['error', { replacements: { dev: false } }],
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax],
      'unused-imports/no-unused-imports': 'error',
      // DDD レイヤの依存方向。domain は infra と commands を import できない。
      // 向きは commands → domain ← infra。
      // mcp は commands、domain、infra を import できる。逆方向は不可で、mcp から他レイヤへの一方向。
      'import-x/no-restricted-paths': ['error', {
        zones: [
          { target: './src/domain', from: './src/infra', message: 'domain から infra への import 禁止 (依存方向違反)' },
          { target: './src/domain', from: './src/commands', message: 'domain から commands への import 禁止 (依存方向違反)' },
          { target: './src/infra', from: './src/commands', message: 'infra から commands への import 禁止 (依存方向違反)' },
          { target: './src/domain', from: './src/mcp', message: 'domain から mcp への import 禁止 (依存方向違反)' },
          { target: './src/infra', from: './src/mcp', message: 'infra から mcp への import 禁止 (依存方向違反)' },
          { target: './src/commands', from: './src/mcp', message: 'commands から mcp への import 禁止 (依存方向違反)' },
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
    // 例: domain/tests から infra のテストヘルパ (engine 実装) を直接呼ぶケース。
    // 具体的には pptx-ooxml/tests/merge.test.ts が XmldomXmlEngine を直接 new するため
    // zone を緩和する。長期的には _helpers 経由に統一すべき (別 issue で扱う)。
    files: ['src/**/tests/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': 'off',
    },
  },
  {
    // infra/slidev-to-pptx/tests では Playwright 互換 cast / null 表現が頻出するため緩和する
    files: ['src/infra/slidev-to-pptx/tests/**/*.ts'],
    rules: {
      'unicorn/no-null': 'off',
      'unicorn/prefer-global-this': 'off',
      'unicorn/no-useless-promise-resolve-reject': 'off',
      'vitest/no-conditional-expect': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@stylistic/max-statements-per-line': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // xpath の型を xmldom 型で再宣言するローカル d.ts。`declare module` は TSModuleDeclaration
    // のため namespace 禁止ルールに当たるが、宣言ファイル以外に置き場がない。
    files: ['types/**/*.d.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      // 第三者ライブラリの型の写し。xmldom の Node は mutable な DOM ノードで readonly 化できない。
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
  {
    // xmldom は ChildNode mixin（remove / append 等）を実装しない。
    // unicorn の DOM 系ルールは、存在しない API へ --fix で書き換え、実行時に失敗する。
    // そこで、実際に発火する 2 ルールだけを無効化する。
    // `prefer-modern-dom-apis` は、このファイルでは発火しない。
    files: ['src/infra/pptx-ooxml/xml-engine.ts'],
    rules: {
      'unicorn/prefer-dom-node-remove': 'off',
      'unicorn/prefer-dom-node-append': 'off',
    },
  },
  {
    // xmldom は selector API（querySelector*）を実装しない。
    // unicorn/prefer-query-selector は、存在しない API へ --fix で書き換え、実行時に失敗する。
    // そのため無効化する。
    // `prefer-modern-dom-apis` は、このファイルでは発火しない。
    files: ['src/domain/drawio/url.ts'],
    rules: {
      'unicorn/prefer-query-selector': 'off',
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
