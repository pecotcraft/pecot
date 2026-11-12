---
pecot-workflow: patch
---

w-merge のマージ待ちが、チェックが通ったあとにルールで止まった PR を待ち続けない。
待つのは merge queue の中とチェックの実行中だけで、ほかは止まった理由を出して抜ける。
