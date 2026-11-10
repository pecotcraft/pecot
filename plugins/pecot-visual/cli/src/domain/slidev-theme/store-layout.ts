// テーマの置き場（ThemeStore）の純粋な計算。
//
// 置き場は `${storeRoot}/<sha256(url) の先頭 16 桁>/<タグ>/` で、中に `package/`（取得物）と `stamp.json` を置く。
// 取得そのもの（git・pnpm・patch の子プロセス）は infra/slidev-theme/store.ts が行う。
// ここには、パスの決め方、stamp の形、再利用の判定に使う inputsHash、git の失敗の分け方を置く。

import { createHash } from 'node:crypto'
import path from 'node:path'

import { isRecord } from '../_shared/json.js'
import { type PatchDigest, sortPatchDigests } from '../_shared/patch-digest.js'

/**
置き場の識別に使う、git の取得元。
*/
export interface ThemeStoreSpec {
  readonly url: string
  readonly tag: string
}

const URL_HASH_LENGTH = 16

/**
`${storeRoot}/<sha256(url) の先頭 16 桁>/<タグ>`。url が違えば別の階層、タグが違えば同じ階層の別ディレクトリになる。
*/
export function themeStoreDirectory(storeRoot: string, spec: Readonly<ThemeStoreSpec>): string {
  const hash = createHash('sha256').update(spec.url).digest('hex').slice(0, URL_HASH_LENGTH)
  return path.join(storeRoot, hash, spec.tag)
}

/**
`stamp.json` の中身。取得が最後まで通ったときにだけ置く。
*/
export interface ThemeStamp {
  readonly spec: ThemeStoreSpec
  readonly fetchedAt: string
  readonly inputsHash: string
}

/**
再利用の判定に使うハッシュ。`package/package.json` の本文と、patch の内容ハッシュから作る。
置き場の実体から再計算して stamp と比べるため、取得後に書き換えられた置き場は再利用されない。
*/
export function computeInputsHash(packageJsonText: string, patches: readonly PatchDigest[]): string {
  const sorted = sortPatchDigests(patches)
  return createHash('sha256').update(JSON.stringify({ packageJson: packageJsonText, patches: sorted })).digest('hex')
}

/**
`stamp.json` の本文を読む。読めない・形が違うときは undefined。
*/
export function parseThemeStamp(text: string): ThemeStamp | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const { spec, fetchedAt, inputsHash } = parsed
  if (typeof fetchedAt !== 'string' || typeof inputsHash !== 'string' || !isRecord(spec)) return undefined
  const { url, tag } = spec
  return typeof url === 'string' && typeof tag === 'string' ? { spec: { url, tag }, fetchedAt, inputsHash } : undefined
}

/**
取得の失敗の分類。git の stderr で connection・auth・tag に分け、pnpm と patch の失敗は install にする。
*/
export type ThemeFetchErrorReason = 'connection' | 'auth' | 'tag' | 'install' | 'unknown'

export class ThemeFetchError extends Error {
  constructor(message: string, readonly reason: ThemeFetchErrorReason) {
    super(message)
    this.name = 'ThemeFetchError'
  }
}

/**
git の失敗の種類。LC_ALL=C で固定した英語の stderr の文言で分ける。
*/
export type GitFailureKind = 'connection' | 'auth' | 'tag' | 'unknown'

// 文言は git の出力そのもの。認証はローカルで再現できないため、確かめた stderr を unit test の入力にする。
const GIT_FAILURE_PATTERNS: readonly (readonly [Exclude<GitFailureKind, 'unknown'>, readonly RegExp[]])[] = [
  ['tag', [/couldn't find remote ref/u]],
  ['auth', [
    /could not read Username/u,
    /Authentication failed/u,
    /terminal prompts disabled/u,
    /Permission denied \(publickey\)/u,
    /Host key verification failed/u,
  ]],
  ['connection', [
    /Could not connect/u,
    /Failed to connect to/u,
    /Connection timed out/u,
    /Connection refused/u,
    /Network is unreachable/u,
    /Could not resolve host/u,
    /SSL certificate problem/u,
  ]],
]

/**
git の stderr から失敗の種類を決める。どれにも当たらなければ unknown。
*/
export function classifyGitFailure(stderr: string): GitFailureKind {
  for (const [kind, patterns] of GIT_FAILURE_PATTERNS) {
    if (patterns.some(pattern => pattern.test(stderr))) return kind
  }
  return 'unknown'
}

/**
失敗の種類ごとの、利用者が次にすることを含む文言。
*/
export function gitFailureAdvice(kind: GitFailureKind, spec: Readonly<ThemeStoreSpec>): string {
  switch (kind) {
    case 'connection': {
      return `cannot connect to the theme source: ${spec.url} (fix: check the network and proxy; `
        + 'if it stops at SSL certificate verification, set git http.sslCAInfo to the CA bundle of the TLS-intercepting proxy)'
    }
    case 'auth': {
      return `authentication failed for the theme source: ${spec.url} `
        + '(fix: set up git credentials, a credential helper or an SSH key, and retry)'
    }
    case 'tag': {
      return `tag not found in the theme source ${spec.url}: ${spec.tag} (fix: check the tag name; branch names are not accepted)`
    }
    case 'unknown': {
      return `git could not fetch the theme source: ${spec.url}`
    }
  }
}
