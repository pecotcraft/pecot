/**
 * compare-pptx.mjs / compare-cx-measure.mjs の CLI 引数解析で共通の
 * `--opt value` / `--opt=value` 両対応ロジック。
 */

/**
 * argv を位置引数・フラグ・値付きオプションへ分ける。
 *
 * `flags` は値を取らないオプション名（例: `['--all']`）、`valued` は値を取る
 * オプション名（例: `['--out', '--max-list']`）。未対応の `--` オプションと、値付き
 * オプションで値が無い場合は例外を投げる。
 *
 * 戻り値: { positional: string[], values: Record<string, string>, flags: Set<string> }
 */
export function parseOptions(argv, { flags = [], valued = [] } = {}) {
  const positional = []
  const values = {}
  const seenFlags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (flags.includes(arg)) {
      seenFlags.add(arg)
      continue
    }
    const valuedName = valued.find((name) => arg === name || arg.startsWith(`${name}=`))
    if (valuedName !== undefined) {
      if (arg.startsWith(`${valuedName}=`)) {
        values[valuedName] = arg.slice(valuedName.length + 1)
      } else {
        index += 1
        if (index >= argv.length) throw new Error(`${valuedName} に値がありません`)
        values[valuedName] = argv[index]
      }
      continue
    }
    if (arg.startsWith('--')) throw new Error(`未対応のオプション: ${arg}`)
    positional.push(arg)
  }
  return { positional, values, flags: seenFlags }
}
