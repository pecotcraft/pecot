---
pecot-workflow: patch
---

MCP のツールがリモートや `setup_command` を待つ間も、MCP サーバが ping へ答えるようにした。
取り消すと、待っている git・gh・コマンドを、その子のプロセスまで止める。
`release` の事前確認の ls-remote と、`session finish` の `git pull` は、認証の入力を待たず、時間切れで止まる。
