/**
 * compare-pages.mjs の CLI 引数解析。`--opt value` と `--opt=value` の両方を受け付ける。
 * pptx-compare と同じ方針で、レーン間の import を避けるため同内容をこちらに置く。
 */

/**
 * argv を位置引数と値付きオプションへ分ける。
 * 未対応の `--` オプションと、値が無い値付きオプションは例外を投げる。
 * 戻り値: { positional: string[], values: Record<string, string> }
 */
export function parseOptions(argv, { valued = [] } = {}) {
  const positional = []
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const name = valued.find((n) => arg === n || arg.startsWith(`${n}=`))
    if (name !== undefined) {
      if (arg.startsWith(`${name}=`)) {
        values[name] = arg.slice(name.length + 1)
      } else {
        index += 1
        if (index >= argv.length) throw new Error(`${name} に値がありません`)
        values[name] = argv[index]
      }
      continue
    }
    if (arg.startsWith('--')) throw new Error(`未対応のオプション: ${arg}`)
    positional.push(arg)
  }
  return { positional, values }
}
