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

引数に `project=<名前>` があれば、このスキルで使う pecot-workflow の MCP ツールに、その名前を `project` で渡す。渡す先は `pr_show` の 1 つ。

### Step 1: PR 情報を取得

引数の PR の本文・diff・既存レビューを読む。

pecot-workflow の MCP ツール `pr_show` を使って、PR とレビューを読む（`reviews: true`）。

diff は `gh pr diff <PR番号> --repo <owner/repo>` で読む。長い diff がファイルとして渡されたときは、そのファイルを `Read` で読む。

PR が閉じる Issue（`pr_show` の `closing_issues`）があれば、公式の MCP の `issue_read` で、それも読む。本文は `get`、コメントは `get_comments` で読む。`referenced_issues` の Issue は読まない。

読んだ Issue のコメントから、計画のコメントを探す。計画のコメントは、`## Plan` と `## PECOT-Workflow` の 2 つの見出しを持つ。複数あれば、新しい方を使う。Issue が複数あれば、Issue ごとに探す。

`closing_issues` が空のときと、計画のコメントが見つからないときは、計画と照らす手順を飛ばしてレビューを続ける。

前の自動レビューの `review-findings` と、書き手が対応を書いたコメント（`## Resolution`）は、次のコマンドで読む。PR のコメントには CUJ のログもあるので、`## Findings` か `## Resolution` で始まるコメントだけを出す。`review-findings` があれば、この実行は 2 巡目以降になる。

```bash
gh pr view <PR番号> --repo <owner/repo> --json comments --jq '.comments[] | select(.body | test("\\A\\s*## (Findings|Resolution)")) | .body'
```

### Step 2: 前の指摘が直ったかを見る（2 巡目以降）

前の `review-findings` の Disposition に並ぶ F-NN のうち、スレッドが未解決のものと、インラインでないものを、今の diff で確かめる。

- F-NN ごとに、直ったか・直っていないかを決める
- 直ったかの判断は、指摘の要旨と今のコードで行う。前の指摘を書き直さない
- Resolved 済みのスレッドの F-NN は見ない

1 巡目は、この Step を飛ばす。

### Step 3: diff をレビュー

Step 1 の情報で、main が diff をレビューする。視点・返し方・調べ方は [レビューの視点](references/review-viewpoints.md) に従う。Step 1 で計画のコメントを読めたときは、その参照の「計画と照らす」にも従う。

前の指摘と同じ趣旨のものは、新しい指摘にしない。Step 2 の結果に含める。

### Step 4: 指摘を採番し、インラインコメントと `review-findings` に振り分けて投稿

新しい指摘と、まだ番号の無い外部レビューコメントに、F-NN の続きの番号を振る。1 巡目は `F-01` から振る。2 巡目以降は、前の `review-findings` とスレッドにある最大の番号の次から振る。番号は PR の中の通し番号にし、振り直さない。

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

2 巡目以降は、Step 2 で見た前の F-NN も Disposition に並べる。

- F-NN の欄は、前のスレッドのコメントへのリンクにする。URL は `pr_show` の行コメントの `url` から取る
- 直ったものは、想定する方針の欄を「直った」にする
- 直っていないものは「対応」にする

1. pecot-workflow の MCP サーバの resource `pecot-template://comment/review-findings` を読み、ガイドを読む
2. frontmatter の `owner`・`repo`・`issue_number` に、この PR を書く
3. pecot-workflow の MCP ツール `issue_comment_check` に通してから、公式の MCP の `add_issue_comment` で投稿する。手順は [Issue とコメントを公式の MCP で書く](../w-help/references/issue-write.md) の「コメントを書く」

投稿したら終わる。採否は聞かず、コードは直さない。スレッドの resolve もしない。
