// 実行時依存の manifest が完全一致で書いた peer の版と、依存ルートの実体の版が一致することのチェック。
//
// テーマは peerDependencies を完全一致の版で宣言し、利用側の依存ルートが同じ版を提供する前提で動く。
// 開発環境の依存ルートは repo root の node_modules（hoisted）で、単体配布の永続層は manifest から作る。
// manifest の版と hoisted の版が離れると、開発環境のテストと配布物が別の版で動く。
// 範囲の外の版が root に載る原因は、推移依存の別の版の hoist である（uuid を overrides で揃えている理由）。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはリポジトリ内の追跡ファイルと install 済み manifest のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// tests/unit/infra → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const RUNTIME_MANIFEST = path.join(PLUGIN_ROOT, 'assets', 'slidev', 'runtime', 'package.json')
const DEPENDENCY_ROOT = path.join(REPO_ROOT, 'node_modules')

/**
テーマが peerDependencies として要求する 11 件。THEME.md の契約で、manifest が完全一致の版で持つ。
*/
const PEER_NAMES: readonly string[] = [
  '@shikijs/langs',
  '@shikijs/themes',
  '@slidev/client',
  '@slidev/types',
  '@vueuse/core',
  'dayjs',
  'html2canvas',
  'lodash-es',
  'shiki',
  'uuid',
  'vue',
]

const EXACT_VERSION = /^\d+\.\d+\.\d+$/u

/**
JSON ファイルの `version` と `dependencies` を読む。無ければ未 install として明示的に失敗させる。
*/
function readJson(file: string): { readonly version?: string, readonly dependencies?: Readonly<Record<string, string>> } {
  expect(existsSync(file), `未 install または不在: ${file}`).toBe(true)
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  return JSON.parse(readFileSync(file, 'utf8')) as { version?: string, dependencies?: Record<string, string> }
}

describe('manifest の peer と依存ルートの版', () => {
  const dependencies = new Map(Object.entries(readJson(RUNTIME_MANIFEST).dependencies ?? {}))

  it('peer 11 件が完全一致の版で書かれている', () => {
    const notExact = PEER_NAMES
      .filter(name => !EXACT_VERSION.test(dependencies.get(name) ?? ''))
      .map(name => `${name}: ${dependencies.get(name) ?? '(宣言なし)'}`)

    expect(notExact, `完全一致の版でない peer:\n${notExact.join('\n')}`).toEqual([])
  })

  it('peer 11 件の版が依存ルートの node_modules/<name>/package.json と一致する', () => {
    const mismatches = PEER_NAMES
      .map(name => ({
        name,
        declared: dependencies.get(name),
        actual: readJson(path.join(DEPENDENCY_ROOT, ...name.split('/'), 'package.json')).version,
      }))
      .filter(({ declared, actual }) => declared !== actual)
      .map(({ name, declared = '(宣言なし)', actual = '(版なし)' }) => `${name}: manifest=${declared} / 依存ルート=${actual}`)

    expect(mismatches, `版が食い違っている peer:\n${mismatches.join('\n')}`).toEqual([])
  })
})
