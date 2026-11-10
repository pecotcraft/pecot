---
pecot-visual: patch
pecot-tools: patch
pecot-workflow: patch
text-rules: patch
---

lock の作り直しで推移依存が変わった。
`@babel/parser` を 7.29.9 から 7.29.13 に更新し、重複した `@typescript-eslint/*` と `parse5` を 1 つの版にまとめた。
