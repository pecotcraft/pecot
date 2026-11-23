---
pecot-workflow: patch
---

MCP のツールから、入力 `dry_run` と結果の `dryRun` を外しました。予行は CLI の `--dry-run` で行います。
予行のときだけ欠けていた結果の項目は、成功のときにいつも入ります。
