---
name: w-revise
description: |
  PRのレビュー指摘を分析し修正を適用します。
  Use after creating a PR to self-review and improve it before merge — one w-reviewer reviews the diff from three viewpoints, reusing the one that reviewed the plan when it is still waiting (w-e2e-planner runs the CUJs when the plan has them), and main applies the adopted fixes. Triggers: "review the PR", "address review comments".
  Only for your own team's PR — not for reviewing other teams' PRs.
when_to_use: "PR のレビュー指摘に対応したい、マージ前に PR を見直して直したい"
---

# レビュー対応

自 PR を w-reviewer に見てもらい、指摘を PR に投稿する。ユーザーに採否を一括で確認し、採用分だけ直してコミットする。最後に対応報告を投稿する。

## 手順

### Step 1: PR 情報を取得

対象 PR の本文・diff・既存レビューを読む。引数が無ければ、会話から一意に決まる PR を使う。決まらなければユーザーに聞く。

pecot-workflow の MCP ツール `pr_show` を使って、PR とレビューを読む（`reviews: true`）。

紐づいた Issue があれば、pecot-workflow の MCP ツール `issue_show` を使って、それも読む。

### Step 2: w-reviewer にレビューを依頼

Step 1 の情報を渡し、w-reviewer に diff をレビューさせる。視点は w-reviewer の定義が持つ。追質問は `SendMessage` で送る。

- 同じセッションに、w-active の Step 8 で計画をレビューした w-reviewer が残っていれば、新しく起こさない。`SendMessage` で `to: "w-reviewer"` に PR の diff のレビューを依頼する
- 残っていなければ（別のセッション・計画をレビューしていない PR など）、`Agent` ツールで `name: w-reviewer` を付けて新しく起こす

PR の計画に CUJ があるときだけ、w-e2e-planner も単発 spawn し、CUJ を実行させる。レビューではなく、検証として起こす。prompt には CUJ の 3 要素（誰が・起点・合格基準）を貼る。

- w-reviewer への依頼と w-e2e-planner の spawn は、並列を既定とする。直列にする場合のみ、理由を `w-reviewer` への依頼の Goal（冒頭行）末尾に括弧書きで添える（例: `(直列の理由: ...)`）
- 1 メッセージ内の複数の呼び出し（`SendMessage` か `Agent`）で依頼する。別メッセージで順に呼ぶと直列になる。

Resolved 済みの既存スレッドは対象に含めない。

### Step 3: 指摘を採番し、インラインコメントと `review-findings` に振り分けて投稿

レビュアーの指摘と既存の外部レビューコメントをまとめ、`F-01` から連番を振る。

投稿先は次のとおり。外部レビュアーの指摘は投稿し直さず、`review-findings` の Disposition に元スレッドの URL を添えて並べるだけにする。

| 指摘 | 投稿先 |
|---|---|
| diff のハンク内の行を指せる | インラインコメント |
| ファイル単位でしか言えない | ファイルコメント |
| それ以外（PR 本文・欠落・diff 外・横断的な設計） | `review-findings` の General 節 |

インラインコメントの本文は `**F-NN** [視点の印]` で始める。印は w-reviewer が返した `[tech]`・`[cuj]`・`[quality]` のどれかにする。`<...>` のプレースホルダ・チェックボックス記法を書かず、型や比較の記法はバッククォートで囲む。

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
    {"path": "cli/core/sections.py", "line": 42, "side": "RIGHT", "body": "**F-01** [quality] 指摘内容"}
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

次のクエリで、先頭コメントの `**F-NN**` からスレッドの `id` と `url` を引き、Step 6 まで保持する。

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

テンプレを取り、ガイドに従って書いて、修正の前に投稿する。General にはインラインにできなかった指摘だけを書く。Disposition には全 F-NN を 1 行ずつ並べ、コメントの URL を添える。

1. pecot-workflow の MCP ツール `issue_comment` を使って、PR 宛てのテンプレのファイルを作る。入力は `prepare: true`・`template: "review-findings"`
2. 書いたら、`issue_comment` を使って、そのファイルを投稿する

### Step 4: 対応可否をユーザーに一括確認

Step 3 で投稿したコメントの URL を示し、AskUserQuestion で次の 3 択（と Other）を出す。指摘ごとには聞かない。

| label | description |
|---|---|
| すべて対応 | F-01 から F-NN まで全件を修正 |
| 一部のみ対応 | Other 自由入力で採用する F-NN をカンマ区切り指定（例: `F-01, F-03`） |
| 対応なし | すべての指摘を「ユーザー判断で対応不要」として report に記録 |

指摘が 0 件なら、Step 3 と Step 6 のコメントを 0 件の文言で投稿し、Step 4・5 と resolve を飛ばす。

### Step 5: 採用分を直し、main がコミット

まず、選択に関わらず次の 2 つを行う。

1. `issue_comment` を使って、PR 宛てのテンプレのファイルを作る（`prepare: true`・`template: "review-resolution"`）。Decision 節と Declined 節を埋める。

2. 対応不要の F-NN のスレッドに、理由を返信する（Step 3 の `in_reply_to`）。

「対応なし」ならここで Step 6 へ進む。採用分があれば、main が直すことを基本にする。

委譲するかは、w-help の [サブエージェントの使い方](../w-help/references/subagent-usage.md) の委譲する条件で決める。当たらなければ main が直し、w-implementer を起こさない。

条件に当たって委譲するときは、次のとおりにする。

- 複数 w-implementer の並列起動を既定とする。直列にする場合のみ、理由を `w-implementer-1` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）
- 採用した F-NN をファイル群で分け、1 群に 1 体を割り当てる。同じファイルを 2 体に渡さない。ファイルに紐づかない F-NN は main が直す
- 群ごとに実装者のモデル（`sonnet` / `opus`）を選び、`Agent` の `model` に渡す。基準は w-help の [エージェントのモデル](../w-help/references/agent-models.md)。GitHub Copilot CLI では `model` を省く（auto で名前を渡すと `400 model_not_supported` で失敗する）
- spawn の前に、割り当て表（実装者名 / モデル / 担当 F-NN / 担当ファイル群）をチャットに書く
- 1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。
- 全員の結果がそろったら、main が 1 コミットにまとめる

コミットメッセージには、対応した F-NN を書く。

採用した指摘は、この PR の中で直しきる。後の PR に回さない。

### Step 6: CUJ 再実行・インラインスレッドの一括 resolve・`review-resolution` の投稿

#### CUJ 再実行

Step 2 で w-e2e-planner が実行した CUJ が、直したファイルを読むなら、w-e2e-planner を単発 spawn して再実行させる。prompt には CUJ の 3 要素（誰が・起点・合格基準）と修正の要約を貼る。実投稿を含む CUJ は main が実行する。不合格なら Step 5 の修正に戻る。

#### スレッドを一括 resolve

対応表のクエリを引き直し、次をすべて満たすスレッドを、採用分・対応不要分とも 1 リクエストで resolve する。

- 先頭コメントが `^\*\*(R\d+/)?F-\d+` に一致する
- `isResolved` が false
- 今回の対応表に載っている

alias は F-NN 順に `t1` から振り、スレッド ID はそのまま書く。

```bash
gh api --hostname <対象ホスト> graphql -f query='
  mutation {
    t1: resolveReviewThread(input: {threadId: "<F-01 のスレッド id>"}) { thread { id isResolved } }
    t2: resolveReviewThread(input: {threadId: "<F-02 のスレッド id>"}) { thread { id isResolved } }
  }' \
  | jq -r 'if .data then (.data | to_entries[] | "\(.key) \(.value.thread.isResolved // "FAILED")")
           else "REQUEST FAILED: \(.errors // . | tostring)" end'
```

`FAILED` の alias だけを再送する。出力の行数が対象スレッド数と一致することを確かめる。

#### `review-resolution` を投稿

Step 5 で書き始めたファイルを、テンプレのガイドに従って仕上げて投稿する。コミットの sha と、コミットメッセージにある対応内容は本文に書かない。投稿には `issue_comment` を使う。

チャットには `review-resolution` の本文をそのまま示す。マージが必要なら `/pecot-w:w-merge` を案内する。

## 注意

- 採否は Step 4 のユーザーの判断で決める。指摘を盲目的に適用しない。
- 返信と resolve は、w-revise が開いたスレッドに限る。
- Step 6 より後の 2 巡目以降のレビューも、新しく起こさず、同じ w-reviewer に `SendMessage` で頼む。
- 2 巡目以降は F-NN を `F-01` から振り直し、本文は `**R2/F-01**` の形で始める。前のラウンドで開いた未解決スレッドと同じ趣旨の指摘は、新しく投稿せずそのスレッドに返信する。
