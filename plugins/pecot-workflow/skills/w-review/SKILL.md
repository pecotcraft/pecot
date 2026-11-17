---
name: w-review
description: |
  PRをレビューし、指摘をPRに投稿します。
  Use to review a pull request — reviews the diff and posts the findings on the PR as inline comments and a findings list. It does not fix code; the PR author addresses the findings in w-pr. Runs the same way from a terminal or from an automated workflow. Triggers: "review the PR".
  Only for your own team's PR — not for reviewing other teams' PRs.
when_to_use: "PR をレビューしてほしい、PR に指摘を付けたい"
---

# PR のレビュー

PR の diff を main がレビューし、指摘を PR に投稿して終わる。コードは直さない。指摘への対応は、PR を出した側が w-pr の Step 5 で行う。

## 手順

### Step 1: PR 情報を取得

対象 PR の本文・diff・既存レビューを読む。引数が無ければ、会話から一意に決まる PR を使う。決まらなければユーザーに聞く。

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
| ファイル単位でしか言えない | ファイルコメント |
| それ以外（PR 本文・欠落・diff 外・横断的な設計） | `review-findings` の General 節 |

レビューの指摘のインラインコメントは、本文を `**F-NN** [視点の印]` で始める。印は `[tech]`・`[cuj]` のどれかにする。外部のレビュアーの指摘には印を付けない。`<...>` のプレースホルダ・チェックボックス記法を書かず、型や比較の記法はバッククォートで囲む。

#### ホストと head sha

`gh` には対象 PR のホストを `--hostname` で必ず渡す。cwd の origin から求めるので、対象リポのワークツリーで打つ。空なら止める。未認証なら `gh auth login -h <host>` を案内して止める。

```bash
GH_HOST=$(git remote get-url origin | sed -E 's#^[a-z0-9+.-]+://##; s#^[^@/]*@##; s#[:/].*$##')
[ -n "$GH_HOST" ] || { echo "origin からホストを導出できない" >&2; exit 1; }
gh auth status -h "$GH_HOST"
```

以降のコマンドには、得たホスト名を直接書く。head sha は API から取る。

```bash
gh api --hostname <対象ホスト> repos/<owner>/<repo>/pulls/<PR番号> --jq .head.sha
```

#### インラインコメント

1 つの review にまとめて投稿する。`event` は `COMMENT` にする。インライン対象が 0 件なら投稿しない。本文の改行は `\n` にする。

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/reviews \
  --input - <<'JSON'
{
  "commit_id": "<head sha>",
  "event": "COMMENT",
  "comments": [
    {"path": "cli/core/sections.py", "line": 42, "side": "RIGHT", "body": "**F-01** [tech] 指摘内容"}
  ]
}
JSON
```

422 で拒否されたら、疑わしい 1 件を外して再送し、原因の F-NN を General 節へ回す。

ファイルコメントと、スレッドへの返信は 1 件ずつ投稿する。

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/comments \
  --input - <<'JSON'
{"commit_id": "<head sha>", "path": "cli/core/sections.py", "subject_type": "file", "body": "**F-02** [tech] 指摘内容"}
JSON
```

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/comments \
  --input - <<'JSON'
{"in_reply_to": 1234567, "body": "返信本文"}
JSON
```

`in_reply_to` は、返信先スレッドの先頭コメントの `databaseId`（数値）にする。

#### F-NN とスレッド ID の対応表

次のクエリで、先頭コメントの `**F-NN**` からスレッドの `id` と `url` を引く。w-pr の Step 5 も、このクエリで表を作る。

```bash
gh api --hostname <対象ホスト> graphql \
  -f query='
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated comments(first: 1) { nodes { databaseId body url } } }
          }
        }
      }
    }' \
  -f owner=<owner> -f repo=<repo> -F number=<PR番号>
```

#### `review-findings` を投稿

テンプレを取り、ガイドに従って書いて投稿する。General にはインラインにできなかった指摘だけを書く。Disposition は表にして全 F-NN を 1 行ずつ並べ、F-NN の欄をコメントへのリンクにする。URL を裸で書かない。指摘が 0 件でも、0 件の文言で投稿する。

1. pecot-workflow の MCP ツール `issue_comment` を使って、PR 宛てのテンプレのファイルを作る。入力は `prepare: true`・`template: "review-findings"`
2. 書いたら、`issue_comment` を使って、そのファイルを投稿する

投稿したら終わる。採否は聞かず、コードは直さない。投稿したコメントの URL をチャットに示し、対応は PR を出した側が `/pecot-w:w-pr` の Step 5 で行うと伝える。

## 注意

- 2 巡目以降は F-NN を `F-01` から振り直し、本文は `**R2/F-01**` の形で始める。前のラウンドで開いた未解決スレッドと同じ趣旨の指摘は、新しく投稿せずそのスレッドに返信する。
