---
pecot-workflow: patch
---

`issue create` がボードの欄を書けなかったとき、**警告を出さずに列が空のまま成功で終わる**不具合を修正。
書けなかった欄と値を `warning` で出し、`project activate` の案内を添える。
