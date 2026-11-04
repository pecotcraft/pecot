// Dependabot alert の取得元の型。domain/dependabot.ts が使い、GitHub を使う実体は infra/github/dependabot-source.ts に置く。
// 結果は判別共用体（kind）で返す。例外にしないので、domain のテストはメモリ上の実装で書ける。

import type { JsonValue } from './python-format.js'

/**
失敗した応答の情報。message は API エラーの文（応答の状態を含む）
*/
export interface DependabotFailure {
  readonly message: string
  readonly statusCode: number | undefined
  /**
  応答本文。JSON なら message を添えるために使う
  */
  readonly responseBody: string | undefined
}

/**
結果の種類は kind で判別する。
- ok は、取得できた。
- forbidden は、403 のうちレート制限ではないもの。
- rateLimited は、レート制限による 403。
- failure は、上記以外の API エラー。
- network は、通信の失敗（応答を得られなかった）。
*/
export type DependabotResult<T>
  = | { readonly kind: 'ok', readonly value: T }
    | { readonly kind: 'forbidden', readonly failure: DependabotFailure }
    | { readonly kind: 'rateLimited', readonly failure: DependabotFailure }
    | { readonly kind: 'failure', readonly failure: DependabotFailure }
    | { readonly kind: 'network', readonly message: string }

/**
alert の 1 件。使うのは security_vulnerability.severity だけ
*/
export type DependabotAlert = JsonValue

export interface DependabotSource {
  /**
  open な alert を全件取得する。alerts が無効なとき等は forbidden
  */
  readonly listOpenAlerts: (owner: string, repository: string) => Promise<DependabotResult<readonly DependabotAlert[]>>
  /**
  alerts が有効かを取得する。有効なら true、無効（404）なら false。それ以外の応答は ok にしない
  */
  readonly isAlertsEnabled: (owner: string, repository: string) => Promise<DependabotResult<boolean>>
}
