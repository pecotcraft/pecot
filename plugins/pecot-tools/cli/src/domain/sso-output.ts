// `aws sso login --no-browser --use-device-code` の出力から認証 URL とコードを取り出す（research R5）。
//
// awscli はこの 2 値を構造化して返さないため、行の並びからの抽出が唯一の手段になる。
// 実 awscli 2.36.40 の stdout（採取日 2026-09-07）は次の形で、マーカー行の後に空行を挟んで
// 値が 1 行だけ置かれる。末尾にはコードを自動入力する URL がもう 1 本続く。
//
//   Browser will not be automatically opened.
//   Please visit the following URL:
//
//   https://<start>.awsapps.com/start/#/device
//
//   Then enter the code:
//
//   ZHJW-WDMF
//
//   Alternatively, you may visit the following URL which will autofill the code upon loading:
//
//   `https://<start>.awsapps.com/start/#/device?user_code=ZHJW-WDMF`
//
// URL は各マーカー行より後ろの最初の 1 本だけを見る。末尾の autofill URL は
// 「コードを URL に載せた形」で、これを開けば利用者はコード入力を省ける（RFC 8628 の
// verification_uri_complete に相当する）。
//
// 子プロセスの出力は chunk 単位で届くので、呼び出し側は累積した stdout をそのつど渡し、
// URL とコードが揃う（= undefined でなくなる）まで待つ。autofill 行は両者より後に届き得るため
// 確定条件には入れない。遅れて届いた場合は、再度この関数を通せば補われる。

/**
抽出できた認証 URL とコードの組。片方だけでは利用者が認証を進められないため常に対で扱う。
*/
export interface SsoLoginPrompt {
  readonly verificationUrl: string
  readonly userCode: string
  /**
  コードを自動入力する URL。これを開けばコード入力が要らない。未到達なら無い。
  */
  readonly verificationUrlComplete?: string
}

const URL_MARKER = 'Please visit the following URL:'
const CODE_MARKER = 'Then enter the code:'
/**
login-registry.ts が chunk 単位の再 parse を絞り込むのに使うため export する。
*/
export const AUTOFILL_MARKER
  = 'Alternatively, you may visit the following URL which will autofill the code upon loading:'

/**
マーカー以降で最初に現れる URL 行。
*/
const URL_LINE = /^https?:\/\/\S+$/

/**
認証コード行（`ZHJW-WDMF` のようなハイフン区切りの英数）。
*/
const CODE_LINE = /^[\dA-Z]{4,}-[\dA-Z]{4,}$/

/**
マーカー行より後で、pattern へ最初に一致する行を返す。

行は trim してから見る。マーカーの比較を完全一致にするためと、CRLF が混在したときに
末尾の `\r` で URL 行の `$` が外れるのを防ぐため。
*/
function findAfterMarker(
  lines: readonly string[],
  marker: string,
  pattern: Readonly<RegExp>,
): string | undefined {
  const markerIndex = lines.indexOf(marker)
  return markerIndex === -1 ? undefined : lines.slice(markerIndex + 1).find(line => pattern.test(line))
}

/**
累積した出力から認証 URL とコードを取り出す。両方が揃うまでは undefined を返す。

片方だけ返さないのは、URL だけを先に応答へ載せても利用者が認証を完了できないため。
autofill URL は揃っていれば載せるだけで、これを待って確定を遅らせることはしない。
*/
export function parseSsoLoginOutput(text: string): SsoLoginPrompt | undefined {
  const lines = text.split('\n').map(line => line.trim())

  const verificationUrl = findAfterMarker(lines, URL_MARKER, URL_LINE)
  const userCode = findAfterMarker(lines, CODE_MARKER, CODE_LINE)
  if (verificationUrl === undefined || userCode === undefined) return undefined

  const verificationUrlComplete = findAfterMarker(lines, AUTOFILL_MARKER, URL_LINE)
  return {
    verificationUrl,
    userCode,
    ...(verificationUrlComplete !== undefined && { verificationUrlComplete }),
  }
}
