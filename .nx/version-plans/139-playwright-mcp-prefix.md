---
pecot-visual: patch
pecot-workflow: minor
---

Playwright の MCP サーバが、pnpm を宣言したリポジトリで起動しない問題を直した。
GitHub Copilot CLI では、どのリポジトリでも起動しなかった。
pecot-workflow にも、同じ Playwright の MCP サーバ `pecot-workflow-playwright` を登録した。
