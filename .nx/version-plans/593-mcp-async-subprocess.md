---
pecot-workflow: patch
---

MCP のツールが git・gh・`setup_command` を待つ間も、ping へ答えるようにした。
取り消すと、子プロセスへ SIGTERM を送り、残ればその子ごと止める。子は端末に入力を尋ねられなくなる。
`release` の ls-remote と `session finish` の `git pull` は、時間切れで止まる。
