---
pecot-workflow: patch
---

MCP のツール `review_finish` を `dry_run` で呼ぶと、書くはずのコメントの本文を結果の `body` に返します。
`session_show` は、作業中の Issue の本文を結果の `activeIssue.body` に返します。
