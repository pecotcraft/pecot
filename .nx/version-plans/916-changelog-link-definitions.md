---
workflow-core: patch
pecot-workflow: patch
pecot-actions: patch
---

CHANGELOG の版の節から作るリリースノートに、ファイル末尾の版のリンク定義が入らないようにした。
本文が使うリンクと脚注の定義だけを残し、節の外にある定義は本文の末尾に加える。
`release_check` の返すリリースノートと、release-check の action の出すリリースノートに当たる。
