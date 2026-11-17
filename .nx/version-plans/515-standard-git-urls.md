---
pecot-workflow: patch
---

remote の URL から `owner/repo` を、**git が定める標準の形のすべて**で読むようにした。
`user@host:`・ssh config の別名・`git://`・末尾に `/` の付いた `https://` などの remote でも、`--repo` を省いたコマンドが止まらない。
