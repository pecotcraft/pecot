---
pecot-workflow: patch
---

board sync・自動レビューの雛形の setup-node が、npm のキャッシュを戻さず保存もしなくなる。
置いた `pecot-board-sync.yml` の setup-node にも `package-manager-cache: false` を足す。
