---
pecot-workflow: patch
---

worktree・release・security・dependabot・session の失敗のうち traceback を出していた場面が、`error:` の行と終了コード 1 で止まる。
`session status` は、アクティブな設定ファイルが不正なら warning の行を出して表を続ける。
