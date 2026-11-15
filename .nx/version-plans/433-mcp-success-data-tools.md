---
pecot-tools: major
---

MCP ツールの結果から `stderr` が無くなった。失敗のときの秘匿化した awscli の出力は `log` に入る。
失敗の結果は、失敗の文を `detail` に持つ。
