---
pecot-workflow: patch
---

`board add` が Status を書けないと、**追加に失敗したと読める error で止まる**不具合を修正。
書けなかった列を出し、ID が古いときは列を書く各コマンドが `project activate` を案内する。
