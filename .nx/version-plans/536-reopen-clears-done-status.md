---
pecot-workflow: patch
---

`issue reopen` で開き直した Issue が、ボードの自動化（Auto-close issue）で**閉じ直されることがある**不具合を修正。
ボードの組み込みの `Status` が `Done` なら、開き直す前に値を消す。消したかどうかを MCP の結果の `doneCleared` で返す。
