---
pecot-workflow: patch
---

`pecot pr cleanup --delete-branch` は、`wip/<head>` があるのに削除できなかったとき、warning の行で知らせる。
`pecot session` と `pecot pr` のコマンドは、origin の無いリポで最初の remote を使う。
