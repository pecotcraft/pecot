---
pecot-workflow: major
---

テンプレートを MCP の resource（`pecot-template://`）で出し、`prepare` と `issue_create` の `dry_run` を外した。
予行は新しい `issue_check` で行い、`project_activate` の一覧は `project_search` の `initialized`・`active` で見る。
