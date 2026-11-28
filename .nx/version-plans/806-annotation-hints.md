---
workflow-core: patch
pecot-workflow: patch
pecot-visual: patch
pecot-tools: patch
---

書き込む MCP ツールが、定義書どおりに `destructiveHint` と `idempotentHint` を明示するようにした。
読むだけのツールは `readOnlyHint: true` だけを返す。ツールの動きは変わらない。
