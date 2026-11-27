import path from 'node:path'

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
import { describeTitleConfig } from '../libs/interface-spec/src/eslint/describe-title.ts'
import { tableKeyConfig } from '../libs/interface-spec/src/eslint/table-key.ts'
import { testDescriptionConfig } from '../libs/interface-spec/src/eslint/test-description.ts'

const JA = String.raw`[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]`
const NO_JA = '題に日本語が無い（.claude/rules/test-conventions.md）'
const KUTEN = '題が句点で終わる（.claude/rules/test-conventions.md）'

const baseRestrictedSyntax = [
  { selector: 'TSEnumDeclaration', message: 'enum 禁止: const オブジェクト + as const か discriminated union を使う' },
  { selector: 'TSModuleDeclaration[id.type="Identifier"]', message: 'namespace 禁止: ESM モジュールを使う' },
  { selector: 'TSAsExpression', message: 'as キャスト禁止: satisfies か型ガードを使う。unknown から絞り込む場合は、説明を付けて eslint-disable-next-line を使う。' },
]

// stdout・stderr への直接の書き込みを止める。行は処理の io を通す。
const outputWriteMessage = 'stdout・stderr へ直接書かない: 処理に渡された io を使う'
const outputWriteSyntax = [
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.property.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
]

// 次に打つコマンドの案内を `pecot <グループ> ...` の文字列で書かせない。グループは src/commands-shared/names.ts の COMMAND_GROUPS
const directHintMessage = 'コマンドの案内を文字列で書かない: src/commands-shared/command-hint.ts の commandHint・inputHint を使う（MCP ではツールの呼び方になる）'
const directHintPattern = '/pecot (project|board|issue_dependency|issue_comment|issue|session|pr|review|auto|release|tracker|worktree|branch|workflow) [a-z]/'
// 呼び出しの引数に書いた文の中のロングオプションも止める。.describe() の help の文と、空白の無い値（git の引数など）は止めない
const flagHintMessage = 'フラグ名を文字列で書かない: src/commands-shared/command-hint.ts の inputHint・inputNameHint を使う（MCP では入力名になる）'
const flagHintPattern = String.raw`/(^|[\s(\x60'])--[a-z][a-z-]*[a-z]([\s,.:;)\x60']|$)/`
const flagHintCall = ':matches(CallExpression, NewExpression, TaggedTemplateExpression):not([callee.property.name=\'describe\'])'
const flagHintLiteral = String.raw`Literal[value=${flagHintPattern}][value=/\s/]`
const flagHintTemplate = String.raw`TemplateElement[value.raw=${flagHintPattern}][value.raw=/\s/]`
const directHintSyntax = [
  { selector: `Literal[value=${directHintPattern}]`, message: directHintMessage },
  { selector: `TemplateElement[value.raw=${directHintPattern}]`, message: directHintMessage },
  { selector: `${flagHintCall} > ${flagHintLiteral}`, message: flagHintMessage },
  { selector: `${flagHintCall} > TemplateLiteral > ${flagHintTemplate}`, message: flagHintMessage },
  { selector: `${flagHintCall} > BinaryExpression ${flagHintLiteral}`, message: flagHintMessage },
  { selector: `${flagHintCall} > BinaryExpression ${flagHintTemplate}`, message: flagHintMessage },
  { selector: `${flagHintCall} > ConditionalExpression > ${flagHintLiteral}`, message: flagHintMessage },
  { selector: `${flagHintCall} > ConditionalExpression > TemplateLiteral > ${flagHintTemplate}`, message: flagHintMessage },
  // 見る範囲は引数の直下と、その連結・三項・null 合体の右側・テンプレートの中の三項まで。変数を経た文と return の文は見ない
  { selector: `${flagHintCall} > LogicalExpression[operator='??'] > ${flagHintLiteral}.right`, message: flagHintMessage },
  { selector: `${flagHintCall} > LogicalExpression[operator='??'] > TemplateLiteral.right > ${flagHintTemplate}`, message: flagHintMessage },
  { selector: `${flagHintCall} > TemplateLiteral > ConditionalExpression > ${flagHintLiteral}`, message: flagHintMessage },
  { selector: `${flagHintCall} > TemplateLiteral > ConditionalExpression > TemplateLiteral > ${flagHintTemplate}`, message: flagHintMessage },
]

// 自分の package 名と、AI に向けた MCP の SDK を読まない。action は AI と無関係に動く
const restrictedImportPatterns = [
  { group: ['@pecot/pecot-actions', '@pecot/pecot-actions/*'], message: '自分の package 名を import しない: 相対パスを使う' },
  { group: ['@modelcontextprotocol/*'], message: 'action から MCP の SDK を読まない: AI に向けた部分は pecot-workflow に置く' },
]

export default defineConfig(
  { ignores: ['*/dist/**', 'coverage/**', 'node_modules/**'] },
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
        projectService: true,
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
      // n は .js を .ts に読み替えて dist を探し、build した lib の subpath を見つけられない。解決は tsc が確かめる
      'n/no-missing-import': ['error', { allowModules: ['@pecot/workflow-core'] }],
      'no-restricted-imports': ['error', { patterns: restrictedImportPatterns }],
      // 依存の向き: 起動のファイル（src/<処理>.ts・src/entry.ts）→ src/commands → @pecot/workflow-core の一方向だけを許す
      'import-x/no-restricted-paths': ['error', {
        zones: [
          { target: './src/commands', from: './src', except: ['./commands', './templates', './types'], message: 'commands から起動のファイル（src/<処理>.ts・src/entry.ts）への import 禁止 (依存方向違反)' },
        ],
      }],
    },
  },
  {
    // action のログへ直接書くのは src/entry.ts の io だけ（その行に disable を付ける）
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax, ...outputWriteSyntax, ...directHintSyntax],
    },
  },
  {
    files: ['**/*.test.ts'],
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
  // tests/interface/ のいちばん外の describe の題が、定義書の name にあるかを確かめる。
  describeTitleConfig([path.resolve(import.meta.dirname, 'interface/generated.json')]),
  tableKeyConfig(['**/*.test.ts']),
  testDescriptionConfig(['**/*.test.ts']),
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tsConfigs.disableTypeChecked,
  },
)
