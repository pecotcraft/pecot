import { describe, expect, it } from 'vitest'

import { ConfigError } from '../../domain/config.js'
import { InvalidValueError, PecotError, ProjectRootNotFoundError } from '../../domain/errors.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../../infra/github/errors.js'
import { AbortedError } from '../output.js'
import { exitCodeOfFailure, KIND_BY_CLASS, kindOfFailure } from '../failure.js'
import type { FailureKind } from '../failure-kind.js'
import { UsageError } from '../usage-error.js'
import { capture } from './support.js'
import type { CapturedIo } from './support.js'

function withKinds(): { readonly io: CapturedIo, readonly kinds: FailureKind[] } {
  const kinds: FailureKind[] = []
  return { io: { ...capture(), failureKind: (kind) => {
    kinds.push(kind)
  } }, kinds }
}

describe('exitCodeOfFailure', () => {
  it('使い方の誤りは、枠付きで stderr に出して 2', () => {
    const io = capture()
    expect(exitCodeOfFailure(new UsageError('bad'), io, 80)).toBe(2)
    expect(io.err.join('')).toContain('bad')
  })

  it('確認の中止は、Aborted. を出して 1', () => {
    const io = capture()
    expect(exitCodeOfFailure(new AbortedError(), io, 80)).toBe(1)
    expect(io.err).toEqual(['Aborted.\n'])
  })

  it('報告できる失敗は、error: の行を出して 1', () => {
    const io = capture()
    expect(exitCodeOfFailure(new PecotError('x'), io, 80)).toBe(1)
    expect(exitCodeOfFailure(new InvalidValueError('y'), io, 80)).toBe(1)
    expect(io.err).toEqual(['error: x\n', 'error: y\n'])
  })

  it('それ以外の例外は伝える', () => {
    expect(() => exitCodeOfFailure(new TypeError('bug'), capture(), 80)).toThrow('bug')
  })

  it('原因の名前を io.failureKind に渡す', () => {
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
  it.for(KIND_CASES)('%o は %s', ([error, kind]) => {
    expect(kindOfFailure(error)).toBe(kind)
  })
})

describe('KIND_BY_CLASS', () => {
  it('派生クラスを基底クラスより先に並べる', () => {
    const misordered = KIND_BY_CLASS.flatMap(([base], index) => KIND_BY_CLASS.slice(index + 1)
      .filter(([derived]) => derived.prototype instanceof base)
      .map(([derived]) => `${derived.name} after ${base.name}`))
    expect(misordered).toEqual([])
  })
})
