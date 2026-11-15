---
pecot-workflow: major
---

MCP ツールの結果から `stdout` と `stderr` が無くなった。成功の中身は、ツールごとの `data` で返す。
作ったファイルの絶対パスは `artifacts`、警告は `data.warnings`、失敗の文は `data.detail` に入る。
