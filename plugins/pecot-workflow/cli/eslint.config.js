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
import { tableKeyConfig } from '../../../libs/interface-spec/src/eslint/table-key.ts'
import { testDescriptionConfig } from '../../../libs/interface-spec/src/eslint/test-description.ts'

const JA = String.raw`[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]`
const NO_JA = '題に日本語が無い（.claude/rules/test-conventions.md）'
const KUTEN = '題が句点で終わる（.claude/rules/test-conventions.md）'

const baseRestrictedSyntax = [
  { selector: 'TSEnumDeclaration', message: 'enum 禁止: const オブジェクト + as const か discriminated union を使う' },
  { selector: 'TSModuleDeclaration', message: 'namespace 禁止: ESM モジュールを使う' },
  { selector: 'TSAsExpression', message: 'as キャスト禁止: satisfies か型ガードを使う。unknown から絞り込む場合は、説明を付けて eslint-disable-next-line を使う。' },
]

// stdout・stderr への直接の書き込みを止める。行は @pecot/workflow-core の commands-shared/output.ts の createOutput を通す。
const outputWriteMessage = 'stdout・stderr へ直接書かない: @pecot/workflow-core の commands-shared/output.ts の createOutput を使う'
const outputWriteSyntax = [
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
  { selector: 'CallExpression[callee.property.name=\'write\'][callee.object.property.name=/^(stdout|stderr)$/]', message: outputWriteMessage },
]

// 次に打つコマンドの案内を `pecot <グループ> ...` の文字列で書かせない。グループは @pecot/workflow-core の commands-shared/names.ts の COMMAND_GROUPS
const directHintMessage = 'コマンドの案内を文字列で書かない: @pecot/workflow-core の commandHint・inputHint を使う（MCP ではツールの呼び方になる）'
const directHintPattern = '/pecot (project|board|issue|session|pr|review|auto|release|tracker|worktree|branch|workflow) [a-z]/'
// 呼び出しの引数に書いた文の中のロングオプションも止める。.describe() の help の文と、空白の無い値（git の引数など）は止めない
const flagHintMessage = 'フラグ名を文字列で書かない: @pecot/workflow-core の inputHint・inputNameHint を使う（MCP では入力名になる）'
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

function libraryCommandsPattern(layer) {
  return { group: ['@pecot/workflow-core/commands-shared/*'], message: `${layer} から commands への import 禁止 (依存方向違反)` }
}

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
    // n/hashbang が src/main.ts を package.json の bin（dist/main.js）と結び付け、shebang を許すため。
    settings: { n: { convertPath: [{ include: ['src/**/*.ts'], replace: [String.raw`^src/(.+)\.ts$`, 'dist/$1.js'] }] } },
  },
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
      // DDD レイヤ依存方向: domain ← infra ← commands / mcp の一方向のみ許す。lib（@pecot/workflow-core）の層にも同じ向きを当てる。
      'import-x/no-restricted-paths': ['error', {
        zones: [
          { target: './src/domain', from: './src/infra', message: 'domain から infra への import 禁止 (依存方向違反)' },
          { target: './src/domain', from: './src/commands', message: 'domain から commands への import 禁止 (依存方向違反)' },
          { target: './src/domain', from: './src/mcp', message: 'domain から mcp への import 禁止 (依存方向違反)' },
          { target: './src/infra', from: './src/commands', message: 'infra から commands への import 禁止 (依存方向違反)' },
          { target: './src/infra', from: './src/mcp', message: 'infra から mcp への import 禁止 (依存方向違反)' },
        ],
      }],
    },
  },
  {
    // domain は文字列を受けて値を返す純粋な関数だけにする。ファイル・git・GitHub は infra に置く。
    files: ['src/domain/**/*.ts'],
    ignores: ['src/domain/tests/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [libraryCommandsPattern('domain'), {
          group: ['@pecot/workflow-core/infra/*'],
          message: 'domain から infra への import 禁止 (依存方向違反)',
        }, {
          group: ['node:fs', 'node:fs/*', 'fs', 'fs/*', 'node:child_process', 'child_process'],
          message: 'domain から node:fs・node:child_process の import 禁止 (I/O は infra に置く)',
        }, {
          group: ['node:os', 'os', 'node:net', 'net', 'node:http', 'http', 'node:https', 'https', 'node:process', 'process'],
          message: 'domain から node:os・node:net・node:http・node:https・node:process の import 禁止 (環境と通信は infra に置く)',
        }],
      }],
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'domain ではグローバルの fetch を使わない (通信を担うのは infra)' },
        { name: 'process', message: 'domain ではグローバルの process を使わない (env と終了を担うのは infra)' },
      ],
      'no-restricted-properties': ['error',
        { object: 'globalThis', property: 'fetch', message: 'domain ではグローバルの fetch を使わない (通信を担うのは infra)' },
        { object: 'globalThis', property: 'process', message: 'domain ではグローバルの process を使わない (env と終了を担うのは infra)' },
      ],
    },
  },
  {
    files: ['src/infra/**/*.ts'],
    ignores: ['src/infra/tests/**', 'src/infra/github/tests/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [libraryCommandsPattern('infra')] }],
    },
  },
  {
    // flat config は options 付きの同じ規則を丸ごと置き換えるので、既存の配列と合わせて置く。
    files: ['src/**/*.ts'],
    ignores: ['src/**/tests/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...baseRestrictedSyntax, ...outputWriteSyntax, ...directHintSyntax],
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
  // 表の題の $キー が、キーとして読める形かを確かめる。規則は libs/interface-spec/src/eslint/table-key.ts にある。
  tableKeyConfig(['src/**/tests/**/*.ts', '**/*.test.ts']),
  testDescriptionConfig(['src/**/tests/**/*.ts', '**/*.test.ts']),
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tsConfigs.disableTypeChecked,
  },
)
