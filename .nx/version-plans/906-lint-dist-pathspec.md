---
pecot-actions: patch
---

`lint-dist` が、commit した `<処理>/dist` の中のファイルを比べるようにした。
build は `<処理>/dist` を消してから作るので、source の無くなった古い dist も見つかる。action の動作は変わらない。
