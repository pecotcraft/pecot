---
pecot-visual: major
---

MCP ツールの結果を、MCP の仕様の形にした。`ok`・`exitCode`・`data`・`artifacts`・`message` が無くなった。
ツールごとの項目は `structuredContent` の最上位、成否は `isError`、失敗は `kind` と `detail` で読む。
