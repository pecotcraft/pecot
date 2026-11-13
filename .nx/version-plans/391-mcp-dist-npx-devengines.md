---
pecot-tools: patch
pecot-visual: patch
pecot-workflow: patch
---

MCP の単体配布の登録例が、pnpm の `devEngines` を持つリポを cwd にしても起動する。
登録例はパッケージを位置引数で渡し、`npm_config_package` をサーバの子の npx に残さない。
