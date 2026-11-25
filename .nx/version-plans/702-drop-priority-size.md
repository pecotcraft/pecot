---
pecot-workflow: major
---

`pecot-priority`・`pecot-size` を作らず、値も入れません。`issue_create` の `priority`・`size` を外しました。
既存の 2 つは、承認の後に `project_init` へ `confirm_delete` を付けて消します。
security の Tracker の列 Priority は Severity になりました。
