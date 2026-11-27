---
pecot-workflow: major
workflow-core: minor
actions: minor
---

Issue とコメントを公式の GitHub MCP で書く形にし、pecot-workflow は書く前に通すチェックのツールだけを持つ。
Issue を読み書きする 8 つのツールをなくし、テンプレートの frontmatter を公式のツールの引数の名前にした。
自動処理の雛形は公式の MCP サーバを Docker で起動するので、`workflow_install` で入れ直す。
