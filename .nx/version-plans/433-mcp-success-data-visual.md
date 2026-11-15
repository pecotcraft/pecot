---
pecot-visual: major
---

MCP ツールの結果から `stdout` と `stderr` が無くなった。警告は `data.warnings` に文の配列で入る。
`drawio_create` と `drawio_export` の `data.warnings` も、件数ではなく文の配列になった。
失敗のときの子プロセスの出力は `data.log` に入る。
