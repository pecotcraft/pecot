// code scanning と secret scanning の alert の取得元の型。domain/security-alerts.ts が使い、GitHub を使う実体は infra/github/security-alerts-source.ts に置く。
// 「無効」「解析なし」の見分けは取得元が済ませる。結果は判別共用体（kind）で返すので、domain のテストはメモリ上の実装で書ける。

import type { JsonValue } from './python-format.js'

/**
一覧を取る種類。Dependabot は dependabot-source.ts の取得元が受け持つ
*/
export type ScanKind = 'code-scanning' | 'secret-scanning'

/**
kind で判別する。ok は取れた alert そのもの（件数と番号は domain が数える）。unconfirmed は一覧を読めず無効とも確かめられない（権限不足など）。failure は API エラー、network は応答なし
*/
export type ScanListResult
  = | { readonly kind: 'ok', readonly alerts: readonly JsonValue[] }
    | { readonly kind: 'disabled' }
    | { readonly kind: 'unconfirmed' }
    | { readonly kind: 'failure', readonly message: string }
    | { readonly kind: 'network', readonly message: string }

export interface ScanAlertSource {
  /**
  open な alert を全件取る
  */
  readonly listOpenAlerts: (kind: ScanKind, owner: string, repository: string) => Promise<ScanListResult>
}
