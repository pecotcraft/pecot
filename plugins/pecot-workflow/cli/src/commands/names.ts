// コマンドの名前まわりの小さな関数。help・バインド・定義書の書き出しが同じものを使う。

/**
入力名を長いオプションの形にする。`force_overwrite_active` は `--force-overwrite-active`
*/
export function flagOf(name: string): string {
  return `--${name.replaceAll('_', '-')}`
}

/**
文字列を名前の順（コードユニットの順）に並べる比較関数
*/
export function byName(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
