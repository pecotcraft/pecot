---
pecot-workflow: patch
---

MCP のツール `release_check` に `X.Y.Z` の形でない版を渡すと、alert を調べる前に止まり、`kind` が `invalid-input` の失敗を返します。
