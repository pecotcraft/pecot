// infra/slidev-project/eslint-runner.ts の unit test。
// eslint bin は、argv / cwd を出力するだけの stub に fake resolver で差し替える。
// 子プロセスへ渡す引数と cwd=talk-dir が成立することを、実 spawn で検証する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isRecord } from '../../../src/domain/_shared/json.js'
import { doesRangeAllowMajor } from '../../../src/domain/_shared/version-range.js'
import type { DeckLintInput } from '../../../src/domain/slidev-theme/deck-lint-input.js'
import { SlideLintRuntimeError } from '../../../src/domain/slidev-project/lint.js'
import {
  ChildProcessEslintRunner,
  resolveEslintBin,
} from '../../../src/infra/slidev-project/eslint-runner.js'
import { verifies } from '../../_helpers/verifies.js'

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const ASSETS_DIR = path.resolve(PLUGIN_ROOT, 'assets', 'slidev')
const DECK_LINT_CONFIG = path.resolve(ASSETS_DIR, 'deck-lint.env.config.js')
const LINT: DeckLintInput = {
  referencesDirectories: ['/talk/references', '/theme/references'],
  panels: { panel: { width: 400, height: 300 } },
  markerLayouts: ['marked'],
  rules: { 'slidev-pages-lint/no-missing-page': 'error' },
}

const state = { temporaryRoot: '' }

beforeEach(() => {
  const created = mkdtempSync(path.join(tmpdir(), 'pecotv-eslint-runner-'))
  state.temporaryRoot = realpathSync(created)
})

afterEach(() => {
  rmSync(state.temporaryRoot, { recursive: true, force: true })
})

/**
argv と cwd を JSON で吐くだけの eslint 代役を作る。
*/
function writeStubBin(): string {
  const stub = path.join(state.temporaryRoot, 'stub-eslint.cjs')
  writeFileSync(
    stub,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), deckLint: process.env.PECOTV_DECK_LINT }))\n',
    'utf8',
  )
  return stub
}

describe('ChildProcessEslintRunner', () => {
  it('talk-dir を cwd に、本体の deck lint 設定と JSON formatter で eslint を起動する', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-04')
    const talkDirectory = path.join(state.temporaryRoot, 'talk')
    mkdirSync(talkDirectory, { recursive: true })
    const stub = writeStubBin()

    const result = await new ChildProcessEslintRunner(() => stub).run({
      talkDirectory,
      assetsDirectory: ASSETS_DIR,
      deckLintConfig: DECK_LINT_CONFIG,
      lint: LINT,
    })

    expect(result.exitCode).toBe(0)
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const observed = JSON.parse(result.stdout) as { argv: string[], cwd: string, deckLint: string }
    expect(observed.argv).toStrictEqual([
      '--no-fix',
      '--config',
      DECK_LINT_CONFIG,
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      'pages/**/*.md',
      'slides.md',
    ])
    // flat config の files / ignores は cwd 基準で解決されるため、cwd=talk-dir が成立条件。
    expect(observed.cwd).toBe(talkDirectory)
    // 本体の設定は宣言を読まず、解釈済みの lint の 4 項目を環境変数の JSON で受ける。
    expect(JSON.parse(observed.deckLint)).toStrictEqual(LINT)
  })

  it('glob はシェル展開されず文字列のまま eslint に渡る', async () => {
    const talkDirectory = path.join(state.temporaryRoot, 'talk-glob')
    mkdirSync(path.join(talkDirectory, 'pages'), { recursive: true })
    writeFileSync(path.join(talkDirectory, 'pages', 'a.md'), '# a\n', 'utf8')
    writeFileSync(path.join(talkDirectory, 'pages', 'b.md'), '# b\n', 'utf8')
    const stub = writeStubBin()

    const result = await new ChildProcessEslintRunner(() => stub).run({
      talkDirectory,
      assetsDirectory: ASSETS_DIR,
      deckLintConfig: DECK_LINT_CONFIG,
      lint: LINT,
    })
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const observed = JSON.parse(result.stdout) as { argv: string[] }
    expect(observed.argv).toContain('pages/**/*.md')
  })
})

/**
<root>/outer/node_modules/eslint と <root>/outer/inner (assets 役) を作る。
*/
function writeHoistedEslint(options: Readonly<{
  version?: string
  wantRange?: string
  /**
  assets の package.json を書かない (欠落) / 壊す (不正 JSON)。
  */
  templateManifest?: 'missing' | 'broken'
}>): {
  inner: string
  hoistedBin: string
} {
  const outer = path.join(
    state.temporaryRoot,
    `outer-${options.version ?? 'noversion'}-${options.wantRange ?? 'none'}-${options.templateManifest ?? 'ok'}`,
  )
  const inner = path.join(outer, 'inner')
  const hoisted = path.join(outer, 'node_modules', 'eslint')
  mkdirSync(path.join(hoisted, 'bin'), { recursive: true })
  mkdirSync(inner, { recursive: true })
  writeFileSync(
    path.join(hoisted, 'package.json'),
    JSON.stringify({
      name: 'eslint',
      ...(options.version !== undefined && { version: options.version }),
      bin: { eslint: './bin/eslint.js' },
    }),
    'utf8',
  )
  writeFileSync(path.join(hoisted, 'bin', 'eslint.js'), '', 'utf8')
  if (options.templateManifest === 'broken') {
    writeFileSync(path.join(inner, 'package.json'), '{ not json', 'utf8')
  }
  else if (options.templateManifest !== 'missing') {
    writeFileSync(
      path.join(inner, 'package.json'),
      JSON.stringify({
        name: 'inner',
        ...(options.wantRange !== undefined && { devDependencies: { eslint: options.wantRange } }),
      }),
      'utf8',
    )
  }
  return { inner, hoistedBin: path.join(hoisted, 'bin', 'eslint.js') }
}

describe('resolveEslintBin', () => {
  // 解決先のパスは package manager の配置で変わる。
  // pnpm 11 以降の hoisted linker は同版の依存を symlink で共有し、realpath が assets の外になる。
  // 守るのは「assets/slidev が宣言した版の eslint」。
  it('assets/slidev が宣言した版の eslint bin を解決する', () => {
    const binPath = resolveEslintBin(ASSETS_DIR)
    expect(binPath.endsWith(path.join('bin', 'eslint.js'))).toBe(true)
    const resolvedManifestPath = path.join(path.dirname(binPath), '..', 'package.json')
    const resolvedManifest: unknown = JSON.parse(readFileSync(resolvedManifestPath, 'utf8'))
    const assetsManifestPath = path.join(ASSETS_DIR, 'package.json')
    const assetsManifest: unknown = JSON.parse(readFileSync(assetsManifestPath, 'utf8'))
    const resolvedVersion = isRecord(resolvedManifest) ? String(resolvedManifest['version']) : ''
    const devDependencies = isRecord(assetsManifest) ? assetsManifest['devDependencies'] : undefined
    const wantRange = isRecord(devDependencies) ? String(devDependencies['eslint']) : ''
    const resolvedMajor = Number(resolvedVersion.split('.', 1)[0])
    expect(doesRangeAllowMajor(wantRange, resolvedMajor), `${resolvedVersion} が ${wantRange} を満たさない`).toBe(true)
  })

  it('eslint 未 install の assets は eslint-not-launched で落とす', () => {
    const fakeAssets = path.join(state.temporaryRoot, 'no-deps-assets')
    mkdirSync(fakeAssets, { recursive: true })
    writeFileSync(path.join(fakeAssets, 'package.json'), '{"name":"fake"}', 'utf8')
    expect(() => resolveEslintBin(fakeAssets)).toThrow(/cannot resolve eslint from/)
  })

  // 以下 3 セルは assert の判定方式の全域。
  // 判定材料は、解決した eslint のメジャーが assets/slidev の devDependencies.eslint の range に収まるかどうか。
  // 解決先のパスは見ない。
  // パス前置判定をやめたのは、単体配布の構成では eslint がプラグインルートの兄弟に置かれるため。
  // 置き場所は `_npx/<hash>/node_modules/eslint` で、前置判定では必ず失敗する。
  //
  // assets の外に解決されること自体は許す。実際 <root>/outer/node_modules/eslint は
  // inner の外側だが、assets の要求と同じメジャーなら lint 結果は保証される。

  it('assets の要求と同じメジャーなら、assets の外に解決されても使う', () => {
    const { inner, hoistedBin } = writeHoistedEslint({ version: '9.39.4', wantRange: '^9.17.0' })

    expect(resolveEslintBin(inner)).toBe(hoistedBin)
  })

  it('assets の要求とメジャーが違う eslint は使わず中止する', () => {
    // プラグイン側で hoist 構成が変わり CLI 側の eslint 10 系が引かれた場合。
    const { inner } = writeHoistedEslint({ version: '10.2.1', wantRange: '^9.17.0' })

    expect(() => resolveEslintBin(inner)).toThrow(/a different major from/)
  })

  it('assets が eslint を宣言していなければ中止する', () => {
    // 宣言が無いまま通すと「どのメジャーでもよい」ことになり、assert が無効になる (fail-closed)。
    const { inner } = writeHoistedEslint({ version: '9.39.4' })

    expect(() => resolveEslintBin(inner)).toThrow(/does not declare devDependencies\.eslint/)
  })

  it('eslint の version が読めなければ中止する (fail-closed)', () => {
    // `Number.parseInt('')` は NaN。
    // 判定材料が無いまま通すと、assets が想定しない eslint で lint が実行される。
    // その結果、違反の検出結果が変わる。
    const { inner } = writeHoistedEslint({ wantRange: '^9.17.0' })

    expect(() => resolveEslintBin(inner)).toThrow(/a different major from/)
  })

  it('version が数字で始まらない場合も中止する', () => {
    const { inner } = writeHoistedEslint({ version: 'next', wantRange: '^9.17.0' })

    expect(() => resolveEslintBin(inner)).toThrow(/a different major from/)
  })

  it('assets の package.json が無ければ eslint-not-launched で中止する', () => {
    // range を読む require が try / catch の外にあると、生の MODULE_NOT_FOUND が伝播する。
    // すると reason 付きの失敗にならない。
    // 同関数の上流で起きる eslint 解決失敗と、扱いを揃える。
    const { inner } = writeHoistedEslint({ version: '9.39.4', templateManifest: 'missing' })

    expect(() => resolveEslintBin(inner)).toThrow(SlideLintRuntimeError)
    expect(() => resolveEslintBin(inner)).toThrow(/cannot read package\.json in/)
  })

  it('assets の package.json が不正 JSON でも SlideLintRuntimeError になる', () => {
    // この場合は Node の package config 検証が先に働くため、上流 (eslint の解決) 側で処理される。
    // どちらで捕まえても reason は eslint-not-launched で揃う。
    const { inner } = writeHoistedEslint({ version: '9.39.4', templateManifest: 'broken' })

    expect(() => resolveEslintBin(inner)).toThrow(SlideLintRuntimeError)
  })

  it('assets/slidev は 10 系を宣言し、解決される eslint も 10 系になる', () => {
    // 現時点で得られた値の固定。
    // メジャーが揃っているため、メジャー判定では plugin root 側の eslint を掴んだかどうかを区別できない。
    // この判定は、assets の想定メジャーから外れた eslint を拒むためのものになる。
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const assetsManifest = JSON.parse(
      readFileSync(path.join(ASSETS_DIR, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> }
    const resolvedBin = resolveEslintBin(ASSETS_DIR)
    const resolvedManifestPath = path.join(path.dirname(resolvedBin), '..', 'package.json')
    // eslint-disable-next-line no-restricted-syntax -- 同上
    const resolved = JSON.parse(readFileSync(resolvedManifestPath, 'utf8')) as { version: string }

    expect(assetsManifest.devDependencies['eslint']).toMatch(/^\^?10\./)
    expect(resolved.version.split('.', 1)[0]).toBe('10')
  })
})
