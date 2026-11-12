---
pecot-workflow: minor
---

`pecot project init` が、既にあるボードに `Blocked` と `Needs Attention` を足す。
`Blocked` の無いボードでも、設定の読み込みは止まらない。
旧版の CLI で設定ファイルを保存し直すと、`fields.status` は消える。
