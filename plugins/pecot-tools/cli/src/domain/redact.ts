// 応答へ載せる前の秘匿化（FR-005 / SC-006 / research R10）。
//
// awscli の通常出力に秘密は含まれないが、想定外のエラーや --debug 相当の出力で
// 資格情報が混入する事態を、応答側の最終段で塞ぐ。

/**
置換後の文字列。
*/
const REDACTED = '[redacted]'

/**
アクセスキー ID。R10 の `(AKIA|ASIA)[0-9A-Z]{16}` と同値（`A[KS]IA` は `AKIA|ASIA`）。
*/
const ACCESS_KEY_ID = /A[KS]IA[\dA-Z]{16}/g

/**
値部だけを差し替える規則（キー名は残し、何が伏せられたか分かるようにする）。

`i` を付けるのは、混入元の本命が環境変数（`AWS_SESSION_TOKEN=...`）とヘッダ
（`X-Amz-Security-Token: ...`）の大文字形のため。

値部を「空白と引用符以外の連続」にするのは、`\S+` だと JSON 文字列の閉じ引用符まで飲み込むため。
`{"note":"aws_session_token=X"}` が不正 JSON になり、後段の JSON.parse が何も言わずに
行配列へ切り替わる。
*/
const KEYED_SECRETS: readonly Readonly<RegExp>[] = [
  /(aws_secret_access_key\s*=\s*)[^\s"']+/gi,
  /(aws_session_token\s*=\s*)[^\s"']+/gi,
  /(x-amz-security-token:\s*)[^\s"']+/gi,
]

/**
アクセスキー ID・シークレット・セッショントークンを [redacted] に置き換える。
*/
export function redactSecrets(text: string): string {
  let redacted = text.replaceAll(ACCESS_KEY_ID, () => REDACTED)
  for (const pattern of KEYED_SECRETS) {
    redacted = redacted.replaceAll(pattern, (_match, key: string) => `${key}${REDACTED}`)
  }
  return redacted
}
