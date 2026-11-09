---
pecot-workflow: minor
---

`pecot pr merge` は、merge queue のあるリポでは PR を queue に入れ、マージされるまで待つ。
待つ秒数は `--wait-timeout` で決め、時間切れは exit 4 で終わる。打ち直すと待ちを続ける。
