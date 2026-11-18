---
name: w-pr
description: |
  PRを作成しタイトル・説明を自動生成し、CIとレビューの指摘に対応します。
  Use when the user wants to create a pull request for the current branch — auto-generates title/description from commits and diff, waits for CI, then addresses the review findings the user adopts. Triggers: "create PR", "submit for review", "address review comments".
  Does not merge PRs (use w-merge).
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__pr_check, mcp__plugin_pecot-w_pecot-workflow__pr_create, mcp__plugin_pecot-w_pecot-workflow__pr_show, mcp__plugin_pecot-w_pecot-workflow__issue_comment, Bash(gh api:*), Bash(git push:*), Bash(git checkout:*), Bash(git branch:*), Bash(git worktree list:*), Bash(git fetch:*), Bash(git pull:*), Bash(mkdir:*), Bash(touch:*), Bash(gh pr view:*), Bash(gh pr edit:*), Bash(gh pr checks:*), Bash(gh run view:*), Bash(git add:*), Bash(git commit:*)
when_to_use: "PR を作りたい、レビューに出したい、プルリクエストの説明文を作ってほしい、PR のレビュー指摘に対応したい"
---

# プルリクエスト作成

現在のブランチの変更内容を分析し、変更内容に合ったタイトルと説明でプルリクエストを作成します。CI を待ち、PR に付いたレビューの指摘のうち、利用者が採ったものを直します。

## 手順

### Step 1: 事前確認

ブランチに PR がもうあるときは、Step 2・3 を飛ばして [Step 4](#step-4-ci-を待って直す) から進む。

pecot-workflow の MCP ツール `pr_check` を使って、PR を作れる状態かを確かめる。指摘があれば解決してから次へ進む。

### Step 2: 変更内容の確認とコミット

1. コミットが必要な場合は自動的にコミットする
   - ステージング済みだがコミットされていない場合、プロジェクトのコミット規約に沿ってコミット（既存履歴 `git log` を参照）
   - コミットメッセージは git diff から生成
   - **不要な確認はしない**（即座にコミット実行）

2. 変更内容を確認する
   - 扱いに困る変更（意図不明、関係なさそう等）があればユーザーに確認
   - 明確な問題がない場合は確認不要

### Step 3: PR作成

1. pecot-workflow の MCP サーバの resource `pecot-template://pr/create` を読み、テンプレートのファイルを作る
2. できたファイルを編集する
   - 冒頭の <!-- 読者: / 書き方: / フィールド: --> ガイドコメントに従って YAML フロントマターと本文を記述する
3. pecot-workflow の MCP ツール `pr_create` を使って、書いたファイルで PR を作る

`base` は空のままにする。ツールが決める。積んで着手したブランチでは下の段のブランチになる。

本文の検証で止まったら、指摘を直して作り直す。
下の段の PR が開いていないと止まったら、エラーの文を利用者に示して止まる。エージェントの判断で `base` を書き換えて作り直さない。

PR を作った後は、結果を見て利用者に伝える。

- PR がスタックに入ったら、その旨を伝える
- この PR を待っていた Issue が動いたら、動いた Issue と列を伝える
- 警告は、利用者に示すだけにする。スタックを手で作らず、PR を作り直さない。PR は作られている

本文に、上下の PR やスタックの中の位置を書かない。GitHub の画面が示す情報だからだ。

#### スクリーンショット

次のどれかが変わる変更は、結果のスクリーンショットを撮って Summary に置く。

- 画面
- ツールが生成して利用者が GitHub で見る Markdown（Issue・PR の本文、コメント、Tracker の表）
- 利用者が読む CLI の出力の文

CHANGELOG・README・SKILL.md の文の変更は含めない。
撮らないときは、フロントマターの `screenshot` に理由を書く（`message` の形では入力 `screenshot`）。
Summary に画像があれば `screenshot` は空のままにする。画像と理由のどちらも無い本文は、`pr_create` が止める。

撮り方は次のとおり。

1. Markdown は `gh api markdown -f mode=gfm -f context=<owner>/<repo> -F text=@<md>` で HTML にする。
   `<article class="markdown-body">` で包み、github-markdown-css を CDN（cdnjs や jsdelivr の版固定 URL）から読ませる
2. CLI の出力は、打ったコマンドと出力を ```` ```console ```` のフェンスに入れ、同じ手順で描画する
3. 下の配信のスクリプトで、`.pecot/work/<Issue番号>` を起点に静的配信を立てる。`cd` と組み合わせない。
   Playwright MCP は初期設定で `file://` を開けないので、http で配信する。
   background で立てる（Claude Code は Bash の background 実行、GitHub Copilot CLI は非同期の実行）。撮り終えたら止める
4. スクリプトが `Serving http://127.0.0.1:<port>/` と出してから、次の URL を Playwright MCP で開く。
   `http://127.0.0.1:<port>/<file>.html`
   `配信を立てられません:` と出て終了したら、port や起点を直して立て直す。
   Playwright MCP の screenshot のツールで撮る。ツール名は Claude Code と GitHub Copilot CLI で違う
5. screenshot のツールの `filename` に相対名を渡すと、workspace root（セッションの作業ディレクトリ）を起点に解かれる。
   `.playwright-mcp/<名前>.png` と書く。名前だけを渡すと、作業ディレクトリの直下に保存される。`git add` に混ぜない

手順 3. の配信は、このスキルの base directory にある `scripts/serve-preview.cjs` を動かして立てる。
作業ディレクトリはリポのルートのままにし、base directory から組んだ絶対パスで打つ。引数は配信の起点と port。

```bash
node <このスキルの base directory>/scripts/serve-preview.cjs .pecot/work/<Issue番号> <port>
```

画像は、本文から `![説明](./画像のファイル名)` で参照し、PR を作った後に gh で載せる。
gh v2.99.0 以上が要る。GHES のリポでは `--attach` が使えない。`screenshot` に理由を書くか、Web の画面で画像を貼る。

```bash
gh pr view <PR番号> --json body -q .body > .playwright-mcp/body.md
gh pr edit <PR番号> --body-file .playwright-mcp/body.md --attach .playwright-mcp/<名前>.png
```

`--attach` は画像ごとに繰り返す。パスには、screenshot のツールの結果に出たパスを使う。本文の画像のパスは、アップロード後の URL に書き換わる。
body.md は画像と同じ `.playwright-mcp/` に置く。gh は本文の `./<名前>.png` を body.md のディレクトリを起点に解く。
置き場所が違うと参照が書き換わらず、画像は本文の末尾に足される。

### Closing Issue キーワードと Epic

- テンプレの `Closes #` は空のままにする。`pr_create` が作業中のタスクの番号で埋める
- 自分で番号を書かない。特に Epic 番号 (sub-issue を持つ親 Issue) を書かない
- ブランチ名末尾の `<num>` も sub-issue 番号にする

### Step 4: CI を待って直す

待つ前に、pecot-workflow の MCP ツール `pr_show` を使って、PR が base とコンフリクトしていないかを確かめる。コンフリクトしていたら、base に載せ直してから待つ。

次のコマンドで CI を待ち、終わった後の結果だけを 1 回出す。Claude Code では Bash の background 実行、GitHub Copilot CLI では非同期の実行で動かす。

```bash
gh pr checks <PR番号> --watch --fail-fast > /dev/null 2>&1; gh pr checks <PR番号>
```

- `no checks reported` が出たら、少しおいて打ち直す。2 回続いたら CI の無いリポとみなし、その旨を伝えて終える
- 落ちたら、PR の変更が原因のものだけ直して push し、待ち直す。関係ない失敗は利用者に伝えて止まる
- 直すのは 3 回まで。超えたら状況を利用者に伝えて止まる

### Step 5: レビューの指摘に対応

CI が通ったら、PR に付いたレビューの指摘に対応する。自動レビューのワークフローがあるリポでは、その job も Step 4 の checks の 1 つとして待ち終えている。

対応する指摘は、次の 2 つから読む。

- PR の未解決のスレッドのうち、先頭が `^\*\*F-\d+` に一致するもの
- 後ろに `review-resolution` の無い `review-findings`

pecot-workflow の MCP ツール `pr_show` で、PR のコメントを読む（`reviews: true`）。
指摘が無ければ、その旨を伝えて終える。

最新の `review-findings` の Disposition で「直った」とされた F-NN は、採否を聞かない。スレッドを resolve する対象にし、`review-resolution` の Applied に書く。

#### F-NN とスレッド ID の対応表

`gh` には対象 PR のホストを `--hostname` で必ず渡す。cwd の origin から求めるので、対象リポのワークツリーで打つ。空なら止める。未認証なら `gh auth login -h <host>` を案内して止める。

```bash
GH_HOST=$(git remote get-url origin | sed -E 's#^[a-z0-9+.-]+://##; s#^[^@/]*@##; s#[:/].*$##')
[ -n "$GH_HOST" ] || { echo "origin からホストを導出できない" >&2; exit 1; }
gh auth status -h "$GH_HOST"
```

次のクエリで、先頭コメントの `**F-NN**` からスレッドの `id`・`url` と、先頭コメントの `databaseId` を引く。以降のコマンドには、得たホスト名を直接書く。

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

#### 対応可否をユーザーに一括確認

`review-findings` のコメントの URL を示し、AskUserQuestion で次の 3 択（と Other）を出す。指摘ごとには聞かない。

| label | description |
|---|---|
| すべて対応 | F-01 から F-NN まで全件を修正 |
| 一部のみ対応 | Other 自由入力で採用する F-NN をカンマ区切り指定（例: `F-01, F-03`） |
| 対応なし | すべての指摘を「ユーザー判断で対応不要」として report に記録 |

指摘が 0 件の `review-findings` なら、`review-resolution` を 0 件の文言で投稿し、この後の修正と resolve を飛ばす。

#### 採用分を直し、main がコミット

まず、選択に関わらず次の 2 つを行う。

1. resource `pecot-template://comment/review-resolution` を読み、PR 宛てのテンプレのファイルを作る。frontmatter の `issue_ref` には PR を書く。Decision 節と Declined 節を埋める。

2. 対応不要の F-NN のスレッドに、理由を返信する。返信先は、対応表の先頭コメントの `databaseId` にする。

   ```bash
   gh api --hostname <対象ホスト> repos/<owner>/<repo>/pulls/<PR番号>/comments \
     -F in_reply_to=<databaseId> -f 'body=返信本文'
   ```

「対応なし」ならここで「スレッドを一括 resolve」へ進む。採用分があれば、main が直すことを基本にする。

委譲するかは、w-help の [サブエージェントの使い方](../w-help/references/subagent-usage.md) の「実装と修正を委譲する条件」で決める。当たらなければ main が直し、w-implementer を起こさない。

条件に当たって委譲するときは、次のとおりにする。

- 複数 w-implementer の並列起動を既定とする。直列にする場合のみ、理由を `w-implementer-1` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）
- 採用した F-NN をファイル群で分け、1 群に 1 体を割り当てる。同じファイルを 2 体に渡さない。ファイルに紐づかない F-NN は main が直す
- 群ごとに実装者のモデル（`sonnet` / `opus`）を選び、`Agent` の `model` に渡す。基準は w-help の [エージェントのモデル](../w-help/references/agent-models.md)。GitHub Copilot CLI では `model` を省く（auto で名前を渡すと `400 model_not_supported` で失敗する）
- spawn の前に、割り当て表（実装者名 / モデル / 担当 F-NN / 担当ファイル群）をチャットに書く
- 1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。
- 全員の結果がそろったら、main が 1 コミットにまとめる

コミットメッセージには、対応した F-NN を書く。

採用した指摘は、この PR の中で直しきる。後の PR に回さない。

#### CUJ 再実行

計画の CUJ（実装の後に実行したもの）が、直したファイルを読むなら、main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流し直す。サブエージェントには渡さない。不合格なら修正に戻る。

#### スレッドを一括 resolve

対応表のクエリを引き直し、次をすべて満たすスレッドを、採用分・対応不要分とも 1 リクエストで resolve する。

- 先頭コメントが `^\*\*F-\d+` に一致する
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

書き始めたファイルを、テンプレのガイドに従って仕上げて投稿する。コミットの sha と、コミットメッセージにある対応内容は本文に書かない。投稿には `issue_comment` を使う。

チャットには `review-resolution` の本文をそのまま示す。

修正を push したら、Step 4 に戻って CI を待つ。

修正を push したあと、pecot-workflow の MCP ツール `session_show` を使って、上の段の PR があるかを確かめる。あれば、その PR の作業ディレクトリで `pr_restack` が要る旨を、チャットの報告に入れる。上の段の作業ディレクトリには入らない。

#### 注意

- 採否はユーザーの判断で決める。指摘を盲目的に適用しない。
- 返信と resolve は、`**F-NN**` で始まるスレッドに限る。

マージは `/pecot-w:w-merge` を使用する。
