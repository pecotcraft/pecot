---
pecot-visual: patch
pecot-tools: patch
pecot-workflow: patch
text-rules: patch
---

nx が undici の修正版を宣言したので、`runtime-workspace.yaml` から **undici の override** を外した。
lock の作り直しで、推移依存の patch 更新も入った。
