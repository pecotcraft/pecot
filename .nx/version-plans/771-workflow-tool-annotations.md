---
pecot-workflow: patch
---

MCP のツールに `readOnlyHint` を付けます。
読むだけの 12 個（`issue_show`・`board_show` など）は、Claude Code のプランモードでも承認なしで動きます。
書き込むツールは、今までどおりプランモードで止まります。
