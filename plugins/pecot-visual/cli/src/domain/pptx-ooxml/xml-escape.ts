// OOXML の part を XML 文字列で組み立てるときの属性値エスケープ。
//
// merge.ts と post-process.ts はどちらも、typeface・href といった外部由来の文字列を属性値に埋める。
// 外部由来とは CSS の font-family や DOM の href を指す。そのため同じ規則を共有する。

/**
XML 属性値用エスケープ。5 つの定義済み実体をすべて置換する。
*/
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}
