---
pecot-workflow: minor
---

フックの `git-no-verify-check` と `git-sync` を初期値で無効にしました。使うときは hooks-config.json で `true` にします。
compact の後も `.pecot/.gitignore` を補います。`develop-aist` への commit は止めなくなりました。
