---
pecot-workflow: patch
---

`session finish` が、**すでに閉じた Issue を閉じ直さない**ようにした。not planned で閉じた Issue の理由が、completed に書き換わらない。
既定ブランチ宛ての PR では、閉じる Issue を GitHub の closing issues にそろえ、本文のコードブロックの中の `Closes #N` を数えない。
