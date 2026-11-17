---
pecot-workflow: patch
---

origin の URL から `owner/repo` を読めないリポでも、**`--repo` を渡したコマンドが止まらない**ようにした。
`warning` を出して `--repo` を使う。`--repo` を省くと、読めない理由を添えて止まる。
