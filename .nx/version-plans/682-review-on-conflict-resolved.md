---
pecot-workflow: patch
---

開いた時点でコンフリクトしていた PR にも、自動レビューが付きます。
雛形（review 6）は push でも起動し、まだ自動レビューの付いていない PR だけをレビューします。
レビュー中に書いた `@pecotbot review` は、後の push で取り消されなくなります。
