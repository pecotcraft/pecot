---
workflow-core: patch
pecot-actions: patch
---

`link-branch` がブランチを作れなかったとき、同じ名前のブランチの有無を読み、エラーの文で理由と直し方を示すようにした。
同じ名前のブランチが Issue につながっていれば、`gh issue develop` と同じく作らずに返す。
