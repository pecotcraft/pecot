---
pecot-workflow: patch
---

`board add` が Status を書けないと、**追加に失敗したと読める error で止まる**不具合を修正。
列を書く各コマンドは、ID が古いときだけ `project activate` を案内する（`issue create` も同じ条件に絞る）。
`issue reopen` は列を書けなくても開き直しとコメントを続け、**終了コード 0** で終わる。
