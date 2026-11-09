---
pecot-workflow: patch
---

`pecot issue comment <ファイル>` が、PR へのコメントも同じファイルで書き換えられるようにした。
書き戻した `comment_url` が `/pull/<番号>#issuecomment-<id>` の形のときに、`comment_url の形が違います` で止まっていた。
`comment_url` のホストが設定のホストと違えば、書き換えずに止まる。
