---
pecot-workflow: patch
---

積んだブランチが remote で載せ直された後、`pr check` と `pr create` の事前確認が、
**古い版で上書きする `git push` ではなく `pr restack` を案内する**ようにした。
