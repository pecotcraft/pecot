---
pecot-workflow: major
---

MCP ツールの結果から `stdout` と `stderr` が無くなった。成功の中身は、ツールごとの項目で返す。
作ったファイルの絶対パスは `file` などの項目、警告は `warnings`、失敗の文は `detail` に入る。
