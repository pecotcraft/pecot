---
pecot-workflow: minor
---

`git-no-verify-check` と `git-sync` を初期値で無効にしました。hooks-config.json の `true` で有効になります。
compact の後も `.pecot/.gitignore` を補い、`develop-aist` への commit を止めなくなりました。
w-pr・w-revise は、CI を待つ前にコンフリクトを確かめます。
