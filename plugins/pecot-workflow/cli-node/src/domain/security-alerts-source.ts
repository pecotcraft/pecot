// code scanning と secret scanning の alert の取得元の型。domain/security-alerts.ts が使い、GitHub を使う実体は infra/github/security-alerts-source.ts に置く。
// 「無効」「解析なし」の見分けは取得元が済ませる。結果は判別共用体（kind）で返すので、domain のテストはメモリ上の実装で書ける。

/**
一覧を取る種類。Dependabot は dependabot-source.ts の取得元が受け持つ
*/
export type ScanKind = 'code-scanning' | 'secret-scanning'

/**
結果の種類は kind で判別する。
- ok は、取得できた。count は open の件数、numbers はそのうち番号が整数のもの。
- disabled は、機能が無効と確かめられた。
- unconfirmed は、一覧を読めず、無効とも確かめられなかった（権限不足など）。
- failure は、上記以外の API エラー。message は応答本文を添えた文。
- network は、通信の失敗（応答を得られなかった）。
*/
export type ScanListResult
  = | { readonly kind: 'ok', readonly count: number, readonly numbers: readonly number[] }
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
