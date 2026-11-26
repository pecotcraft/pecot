#!/usr/bin/env bash
# 起動中の node では MCP のサーバが起動を拒むとき、その案内を出す。判定は cli/src/node-runtime.ts の checkNodeRuntime。

# 引数: $1 = プラグインルート。案内が無い・判定を読めない・node が無いときは何も出さない。
pecotv_node_runtime_message() {
    local plugin_root="$1"
    [ -f "$plugin_root/cli/src/node-runtime.ts" ] || return 0
    command -v node >/dev/null 2>&1 || return 0
    node --input-type=module -e '
import { pathToFileURL } from "node:url"
try {
  const m = await import(pathToFileURL(process.argv[1]).href)
  const r = m.checkNodeRuntime(process.versions.node)
  if (typeof r === "string") process.stdout.write(r)
} catch {}
' "$plugin_root/cli/src/node-runtime.ts" 2>/dev/null || true
}
