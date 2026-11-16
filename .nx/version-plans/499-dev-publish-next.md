---
pecot-workflow: patch
---

board sync の雛形が **npm の最新の正式版（`@latest`）を取る**ようにし、major が上がっても直さずに動く。
互換の無い変更を止めたいときは `@<版>` に替える。main の開発版は `@next` で取れる。
