---
pecot-workflow: patch
---

積んだ PR の Issue が、下の段のマージの後も**ボードで In Progress にならず、閉じない**不具合を修正。
`pr restack` は開発ブランチへ載せ直した後、PR の本文を変えずに保存し直す。GitHub が `Closes` をリンクにする。
保存し直した PR の番号を、MCP の結果の `relinked` で返す。
