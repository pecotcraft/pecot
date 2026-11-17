---
pecot-workflow: patch
---

`issue reopen` で開き直した Issue が、後でボードを書き換えたときに、ボードの自動化（Auto-close issue）で**閉じ直される**不具合を修正。
ボードの組み込みの `Status` が `Done` なら、開き直す前に値を消す。消したかどうかを MCP の結果の `doneCleared` で返す。
