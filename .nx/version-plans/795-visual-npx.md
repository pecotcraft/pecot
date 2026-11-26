---
pecot-visual: major
---

`bin/` と CLI（`pecotv`）をなくし、MCP のサーバは npm の版を npx で起動する。
編集の後の確認は MCP のツールを呼ぶフックに替え、GitHub Copilot CLI では動かなくなった。
データ置き場に残る前の版の `runtime/` は消してかまわない。
