import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { ConfigError } from '../../domain/config.js'
import { InvalidValueError, PecotError, ProjectRootNotFoundError } from '../../domain/errors.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../../infra/github/errors.js'
import { AbortedError } from '../output.js'
import { exitCodeOfFailure, KIND_BY_CLASS, kindOfFailure } from '../failure.js'
import type { FailureKind } from '../failure-kind.js'
import { UsageError } from '../usage-error.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'

function withKinds(): { readonly io: CapturedIo, readonly kinds: FailureKind[] } {
  const kinds: FailureKind[] = []
  return { io: { ...capture(), failureKind: (kind) => {
    kinds.push(kind)
  } }, kinds }
}

describe('exitCodeOfFailure', () => {
  it('使い方の誤りは、メッセージを標準エラー出力へ表示して終了コード 2 を返す', async () => {
    await explains('失敗から終了コードを求める関数（`exitCodeOfFailure`）のテストです。使い方の誤り（`UsageError`）の場合に、メッセージを標準エラー出力へ表示し、終了コード 2 を返すことを確認します。')
    const io = capture()
    expect(exitCodeOfFailure(new UsageError('bad'), io, 80)).toBe(2)
    expect(io.err.join('')).toContain('bad')
  })

  it('確認が中止された場合は、Aborted. と表示して終了コード 1 を返す', async () => {
    await explains('利用者が確認を中止した場合（`AbortedError`）のテストです。`Aborted.` を標準エラー出力へ表示し、終了コード 1 を返すことを確認します。')
    const io = capture()
    expect(exitCodeOfFailure(new AbortedError(), io, 80)).toBe(1)
    expect(io.err).toEqual(['Aborted.\n'])
  })

  it('報告できる失敗の場合は、error: で始まる行を表示して終了コード 1 を返す', async () => {
    await explains('報告できる失敗（`PecotError` と `InvalidValueError`）のテストです。どちらも `error:` で始まる行を標準エラー出力へ表示し、終了コード 1 を返すことを確認します。')
    const io = capture()
    expect(exitCodeOfFailure(new PecotError('x'), io, 80)).toBe(1)
    expect(exitCodeOfFailure(new InvalidValueError('y'), io, 80)).toBe(1)
    expect(io.err).toEqual(['error: x\n', 'error: y\n'])
  })

  it('想定していない例外は、終了コードに変換せず、そのまま再度発生させる', async () => {
    await explains('想定していない例外（`TypeError`）のテストです。終了コードに変換せず、元のメッセージのまま例外が発生することを確認します。')
    expect(() => exitCodeOfFailure(new TypeError('bug'), capture(), 80)).toThrow('bug')
  })

  it('失敗の原因の種類を、io.failureKind に渡す', async () => {
    await explains('失敗の原因の種類を通知する処理のテストです。使い方の誤り・中止・認証の失敗・その他の失敗が、`invalid-input`・`aborted`・`github-auth`・`other` として `io.failureKind` に渡されることを確認します。')
    const { io, kinds } = withKinds()
    exitCodeOfFailure(new UsageError('bad'), io, 80)
    exitCodeOfFailure(new AbortedError(), io, 80)
    exitCodeOfFailure(new GitHubAuthError('no token'), io, 80)
    exitCodeOfFailure(new PecotError('x'), io, 80)
    expect(kinds).toEqual(['invalid-input', 'aborted', 'github-auth', 'other'])
  })
})

const KIND_CASES: readonly (readonly [unknown, FailureKind])[] = [
  [new UsageError('u'), 'invalid-input'],
  [new InvalidValueError('v'), 'invalid-input'],
  [new AbortedError(), 'aborted'],
  [new GitHubAuthError('a'), 'github-auth'],
  [new GitHubNotFoundError('n'), 'github-not-found'],
  [new GitHubRateLimitError('r'), 'github-rate-limit'],
  [new DependenciesUnsupportedError('d'), 'dependency-rejected'],
  [new GitHubAPIError('g'), 'github-api'],
  [new ConfigError('c'), 'config-invalid'],
  [new ProjectRootNotFoundError('p'), 'project-root-not-found'],
  [new PecotError('e'), 'other'],
  [new TypeError('t'), 'other'],
]

describe('kindOfFailure', () => {
  it.for(KIND_CASES)('例外 %o は、原因の種類 %s に分類される', async ([error, kind]) => {
    await explains('例外を原因の種類に分類する関数（`kindOfFailure`）のテストです。使い方の誤り・中止・GitHub のエラー・設定の誤りなどの例外が、対応する種類（`invalid-input` や `aborted` など）に分類されることを確認します。')
    expect(kindOfFailure(error)).toBe(kind)
  })
})

describe('KIND_BY_CLASS', () => {
  it('KIND_BY_CLASS では、派生クラスが基底クラスより前に並ぶ', async () => {
    await explains('例外の分類表（`KIND_BY_CLASS`）のテストです。基底クラスより後ろに派生クラスが並んでいる組が存在せず、派生クラスが先に判定されることを確認します。')
    const misordered = KIND_BY_CLASS.flatMap(([base], index) => KIND_BY_CLASS.slice(index + 1)
      .filter(([derived]) => derived.prototype instanceof base)
      .map(([derived]) => `${derived.name} after ${base.name}`))
    expect(misordered).toEqual([])
  })
})
