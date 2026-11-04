/**
Array#sort() / toSorted() の既定と同じ UTF-16 コード単位順で文字列を比べる。
localeCompare は実行環境のロケールで順序が変わる。キャッシュキーとダイジェストのように
決定性が要る箇所では、環境ごとにずれないようこちらを使う。
*/
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
