// kernel は本文から BOM を落として数えるので、bin と strings plugin が同じ正規表現で落として位置をそろえる。
export const BYTE_ORDER_MARK = /^\u{FEFF}/u
