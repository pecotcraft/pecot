---
pecot-workflow: patch
---

`pr check` と `pr create` の事前確認が、remote とずれたブランチに `git push` を勧めなくなった。
載せ直しが要る積んだブランチには `pr restack` を、それ以外には `git pull --rebase` などを案内する。
