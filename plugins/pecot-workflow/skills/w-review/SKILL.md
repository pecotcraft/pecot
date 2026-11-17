---
name: w-review
description: |
  PRをレビューし、指摘をPRに投稿します。自動レビューのワークフローが起こします。
  Reviews a pull request inside the pecot auto-review workflow on GitHub Actions — reviews the diff and posts the findings on the PR as inline comments and a findings list. It does not fix code; the PR author addresses the findings in w-pr. Not for a local session.
when_to_use: "自動レビューのワークフローが PR をレビューするとき"
---

# PR のレビュー

自動レビューのワークフロー（GitHub Actions）が、PR を作ったときに起こす。PR の diff を main がレビューし、指摘を PR に投稿して終わる。コードは直さない。指摘への対応は、PR を出した側が w-pr の Step 5 で行う。

## 手順

### Step 1: PR 情報を取得

引数の PR の本文・diff・既存レビューを読む。

pecot-workflow の MCP ツール `pr_show` を使って、PR とレビューを読む（`reviews: true`）。

紐づいた Issue があれば、pecot-workflow の MCP ツール `issue_show` を使って、それも読む。

### Step 2: diff をレビュー

Step 1 の情報で、main が diff をレビューする。視点・返し方・調べ方は [レビューの視点](references/review-viewpoints.md) に従う。

Resolved 済みの既存スレッドは対象に含めない。

### Step 3: 指摘を採番し、インラインコメントと `review-findings` に振り分けて投稿

レビューの指摘と既存の外部レビューコメントをまとめ、`F-01` から連番を振る。

投稿先は次のとおり。外部レビュアーの指摘は投稿し直さず、`review-findings` の Disposition の表に、F-NN を元スレッドへのリンクにして並べるだけにする。

| 指摘 | 投稿先 |
|---|---|
| diff のハンク内の行を指せる | インラインコメント |
| それ以外（ファイル単位・PR 本文・欠落・diff 外・横断的な設計） | `review-findings` の General 節 |

#### インラインコメント

action に同梱の MCP ツール `create_inline_comment` で、1 件ずつ投稿する。`confirmed` は `true` にする。投稿が拒否されたら、その F-NN を General 節へ回す。

本文は `**F-NN** [視点の印]` で始める。印は `[tech]`・`[cuj]` のどれかにする。外部のレビュアーの指摘には印を付けない。`<...>` のプレースホルダ・チェックボックス記法を書かず、型や比較の記法はバッククォートで囲む。

#### `review-findings` を投稿

テンプレを取り、ガイドに従って書いて投稿する。General にはインラインにできなかった指摘だけを書く。Disposition は表にして全 F-NN を 1 行ずつ並べ、F-NN の欄をコメントへのリンクにする。URL を裸で書かない。指摘が 0 件でも、0 件の文言で投稿する。

1. pecot-workflow の MCP ツール `issue_comment` を使って、PR 宛てのテンプレのファイルを作り、ガイドを読む。入力は `prepare: true`・`template: "review-findings"`
2. 書いた本文を、`issue_comment` で投稿する。入力は `template: "review-findings"` と、本文を入れた `message`

投稿したら終わる。採否は聞かず、コードは直さない。

## 注意

- 2 巡目以降は F-NN を `F-01` から振り直し、本文は `**R2/F-01**` の形で始める。前のラウンドで開いた未解決スレッドと同じ趣旨の指摘は、新しく投稿せず、Disposition の表でそのスレッドへのリンクにする。
