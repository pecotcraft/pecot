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

export default defineConfig(
  { ignores: ['coverage/**', 'node_modules/**', 'tests/fixtures/**'] },
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      // zod が推論する型は変更可能な型で、検証の関数がそれを引数に取る。
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
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
      'no-restricted-syntax': ['error',
        { selector: 'TSEnumDeclaration', message: 'enum 禁止: const オブジェクト + as const か discriminated union を使う' },
        { selector: 'TSModuleDeclaration', message: 'namespace 禁止: ESM モジュールを使う' },
        { selector: 'TSAsExpression:not([typeAnnotation.typeName.name="const"])', message: 'as キャスト禁止: satisfies か型ガードを使う（as const は許す）' },
      ],
      'unused-imports/no-unused-imports': 'error',
    },
  },
  {
    // 層の向き: domain は infra・cli・validate-repository を知らず、infra は cli・validate-repository を知らない。
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': ['error', {
        basePath: import.meta.dirname,
        zones: [
          { target: './src/domain', from: ['./src/infra', './src/validate-repository.ts', './src/cli.ts'], message: 'domain は infra・cli を import しない' },
          { target: './src/infra', from: ['./src/validate-repository.ts', './src/cli.ts'], message: 'infra は cli を import しない' },
        ],
      }],
    },
  },
  {
    rules: {
      // 定義書のデータは Record と Map を鍵で引く。引くのは自分のオブジェクトだけ。
      'security/detect-object-injection': 'off',
      // パスは --root か fixture の相対パスで、書き込み先は利用者の入力で決まらない。
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // zod の schema は宣言が入れ子になるのが普通の形。
    files: ['src/domain/schema.ts'],
    rules: { 'unicorn/max-nested-calls': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tsConfigs.disableTypeChecked,
  },
)
