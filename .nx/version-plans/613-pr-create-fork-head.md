---
pecot-workflow: minor
---

`pr create` の head に **`owner:branch`** を渡すと、fork のブランチから PR を作れる。
作る前の確かめは、その owner の fork を指す remote に push 済みかを見て、足りなければ remote とブランチ名を添えた直し方を出す。
`--head` で今と別のブランチを指したときも、そのブランチの push を確かめる。
