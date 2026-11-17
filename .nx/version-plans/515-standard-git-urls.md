---
pecot-workflow: patch
---

remote の URL から `owner/repo` を、**GitHub のリポを指せる git の標準の形（スキーム付きと scp 形式）**で読むようにした。
`user@host:`・ssh config の別名・`git://`・末尾に `/` の付いた `https://` などの remote でも、`--repo` を省いたコマンドが止まらない。
