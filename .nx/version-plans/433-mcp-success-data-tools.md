---
pecot-tools: major
---

MCP ツールの結果から `stderr` が無くなった。失敗のときの秘匿化した awscli の出力は `data.log` に入る。
失敗の結果は、`kind` と同じ値の `data.reason` と、`message` と同じ文の `data.detail` も返す。
