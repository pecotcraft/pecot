---
pecot-workflow: major
---

進行の欄の名前を `pecot-status` にし、`project_create`・`project_init` の入力 `suffix` を外しました。
既存のボードは、`project_init` が旧い名前の欄を改名し、設定ファイルを `<host>_<owner>_<番号>.json` に移します。
移した設定は旧い版で読めないので、共有する人と Actions の版をそろえてください。
