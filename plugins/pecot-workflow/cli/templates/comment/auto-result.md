---
template: auto-result
---

<!--
読者: 自動処理（ラベルを契機にした修正の実行）の結果を知りたい Issue の担当者。何が起きたかと、人が次にすることを読む。末尾の「例:」の形になる。

書き方:
- この本文は `pecot auto gate`・`pecot auto finish` が埋めて Issue に投稿する。エージェントも人も、手で書かない
- 結果は `pr-created`・`ci-passed`・`ci-fix-pushed`・`question`・`out-of-scope`・`failed`・`limit`・`setup-missing` のどれかにする
- 結果ごとの本文には、質問・落ちたテスト・落ちているチェック・足りない設定・対象外の理由のうち、その結果に要るものだけを書く。無いときは、その行ごと消える
- 本文の先頭に、`pecot-auto: result=... run=... attempt=... branch=...` を HTML コメントで包んだ、画面に出ない目印の行が付く。同じ実行で 2 度投稿しないことと、CI を直した回数を数えることに使う
- トークンの値と secret の値を書かない

例:

## Auto result — 質問があり、自動処理が止まった

実装の前に、次の点を決めてください。

- 既存の設定ファイルの形式を残すか、新しい形式に移すか

- 結果 — `question`（質問を書いて止まった）
- 実行の記録 — https://github.com/example/repo/actions/runs/123456789
- 次にすること — 答えを Issue にコメントで書き、起動ラベル `pecot-auto` を付け直す
-->

## Auto result — <結果を1行で>

<結果ごとの本文>

- 結果 — <結果>
- 実行の記録 — <実行の記録>
- 次にすること — <次にすること>
