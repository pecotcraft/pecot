---
pecot-workflow: major
workflow-core: minor
actions: minor
---

MCP のサーバを npm の `@pecot/workflow-mcp` から npx で起動するようにし、`bin/` と `pecot` の CLI をなくした。
release check の判定を workflow-core に移し、同じ判定の `release-check` の action を足した。
