---
pecot-workflow: major
---

Issue・PR などのツールが `.active` ではなく、対象のリポを含むプロジェクトの設定を使う。
`.active` の無い checkout でも動き、候補が 2 つ以上で選べなければ `--project` を求める。
対象のリポを含まない設定では動かず、`.active` の切り替えで動かしていた使い方は止まる。
