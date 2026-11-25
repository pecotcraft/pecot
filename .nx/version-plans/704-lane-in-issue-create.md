---
pecot-workflow: minor
---

`issue_create` の `lane`（ファイルでは frontmatter の `lane`）で、Issue を `pecot-lane` の値に分類できます。
指定が無く親の Epic に値があれば、親と同じ値を入れます。
`board_show` は、各 Item の `lane` と、値ごとの件数の `lanes` を返します。w-active の候補は値ごとに分かれます。
