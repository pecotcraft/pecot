---
name: w-pr
description: |
  PRを作成しタイトル・説明を自動生成し、CIとレビューの指摘に対応します。
  Use when the user wants to create a pull request for the current branch — auto-generates title/description from commits and diff, waits for CI, then addresses the review findings without asking which to adopt, replying with the reason on each one it declines. Triggers: "create PR", "submit for review", "address review comments".
  Does not merge PRs itself — it then waits for the user to merge on GitHub and runs the post-merge cleanup (session finish).
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__pr_check mcp__plugin_pecot-w_pecot-workflow__pr_restack mcp__plugin_pecot-w_pecot-workflow__board_check mcp__plugin_pecot-w_pecot-workflow__project_list mcp__plugin_pecot-w_pecot-workflow__issue_comment_check mcp__plugin_pecot-w_pecot-workflow__session_show mcp__plugin_pecot-w_pecot-workflow__session_finish Bash(node ${CLAUDE_SKILL_DIR}/scripts/wait-pr.cjs *) Bash(node ${CLAUDE_SKILL_DIR}/scripts/push-attach.cjs *) Bash(gh api markdown:*) Bash(git push:*) Bash(git checkout:*) Bash(git branch:*) Bash(git worktree list:*) Bash(git fetch:*) Bash(git pull:*) Bash(mkdir:*) Bash(touch:*) Bash(gh pr view:*) Bash(gh pr edit:*) Bash(git add:*) Bash(git commit:*)
when_to_use: "PR を作りたい、レビューに出したい、プルリクエストの説明文を作ってほしい、PR のレビュー指摘に対応したい"
---

# プルリクエスト作成

現在のブランチの変更内容を分析し、変更内容に合ったタイトルと説明でプルリクエストを作成します。CI を待ち、PR に付いたレビューの指摘の採否を自分で決めて対応し、終わってから報告します。直さない指摘には、理由を返信します。
その後も、利用者が GitHub の画面でマージするのを待ち受け、マージされたら後片付けまで済ませます。

## 手順

### Step 1: 事前確認

引数: $ARGUMENTS

引数が `resume` なら、background の待ちが終わった後の呼び直しなので、直前の通知のコマンドに合わせて続ける。

- CI 待ちの `wait-pr.cjs ci` なら、[Step 4](#step-4-ci-を待って直す) の出力を読むところから続ける
- マージ待ちの `wait-pr.cjs merge` なら、[Step 6](#step-6-マージを待ち受けて片付ける) の出力の表から続ける

公式の MCP の `list_pull_requests`（`head` に `<owner>:<今のブランチ>`、`state: open`）で、ブランチの PR を読む。PR がもうあるときは、Step 2・3 を飛ばして [Step 4](#step-4-ci-を待って直す) から進む。

pecot-workflow の MCP ツール `session_show` で、作業中の Issue と、比べる先のブランチ（`baseBranch`）を読む。

### Step 2: 変更内容の確認とコミット

1. コミットが必要な場合は自動的にコミットする
   - ステージング済みだがコミットされていない場合、プロジェクトのコミット規約に沿ってコミット（既存履歴 `git log` を参照）
   - コミットメッセージは git diff から生成
   - **不要な確認はしない**（即座にコミット実行）

2. 変更内容を確認する
   - 扱いに困る変更（意図不明、関係なさそう等）があればユーザーに確認
   - 明確な問題がない場合は確認不要

### Step 3: PR作成

1. pecot-workflow の MCP サーバの resource `pecot-template://pr/create` を読み、`.pecot/tmp/output/` にテンプレートのファイルを作る
2. できたファイルを編集する
   - 冒頭の <!-- 読者: / 書き方: / フィールド: --> ガイドコメントに従って YAML フロントマターと本文を記述する
   - Verified の evidence は、w-help の [CUJ の流し方](../w-help/references/cuj-run.md) の「evidence の残し方」に従って載せる
3. [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「PR を作る・書き換える」に従い、`pr_check` に通してから `create_pull_request` で作る。スタックしたブランチではスタックに入れ、カードを `In Review` へ動かす

`pr_check` が外れた項目を返したら、指摘を直して通し直す。
親 PR が開いていないと返ったら、その文を利用者に示して止まる。エージェントの判断で `base` を書き換えて作り直さない。

PR を作った後は、結果を見て利用者に伝える。

- PR がスタックに入ったら、その旨を伝える
- `stack-register` が失敗したら、実行の URL と `error` を利用者に示すだけにする。スタックを手で作らず、PR を作り直さない。PR は作られている

本文に、上下の PR やスタックの中の位置を書かない。GitHub の画面が示す情報だからだ。

#### 本文に収まらないログ

本文の上限（65,536 文字）を超えるログは、PR を作った後に、PR のコメントへ分けて載せる。

1. ログを `<details>` で包んだファイルを作る。1 件のコメントも 65,536 文字までなので、超えるならファイルを分ける
2. ファイルごとに、pecot-workflow の MCP ツール `issue_comment_check` に `method: add` で通す。通ったら、公式の MCP の `add_issue_comment` で PR に書く。`issue_number` は PR の番号にする。結果のコメントの URL を控える
3. Verified の CUJ の節に、控えたコメントへのリンクを足す。PR の本文の書き換えは、[GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「PR を作る・書き換える」に従う

#### スクリーンショット

次のどれかが変わる変更は、結果のスクリーンショットを撮って Summary に置く。

- 画面
- ツールが生成して利用者が GitHub で見る Markdown（Issue・PR の本文、コメント、Tracker の表）
- 利用者が読む CLI の出力の文

CHANGELOG・README・SKILL.md の文の変更は含めない。
撮らないときは、フロントマターの `screenshot` に理由を書く。
Summary に画像があれば `screenshot` は空のままにする。画像と理由のどちらも無い本文は、`pr_check` が止める。

撮り方は次のとおり。

1. Markdown は `gh api markdown -f mode=gfm -f context=<owner>/<repo> -F text=@<md>` で HTML にする。
   `<article class="markdown-body">` で包み、github-markdown-css を CDN（cdnjs や jsdelivr の版固定 URL）から読ませる。
   公式の MCP に GitHub の描画（`POST /markdown`）を呼ぶツールが無いので、`gh` を使う。手元のライブラリで描くと、GitHub での見え方とずれる
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
GitHub に画像を上げる公開の API は無く、公式の MCP にもアップロードのツールが無い。`gh` だけが上げられる。
gh v2.99.0 以上が要る。GHES のリポでは `--attach` が使えない。`screenshot` に理由を書くか、Web の画面で画像を貼る。

```bash
gh pr view <PR番号> --json body -q .body > .playwright-mcp/body.md
gh pr edit <PR番号> --body-file .playwright-mcp/body.md --attach .playwright-mcp/<名前>.png
```

`--attach` は画像ごとに繰り返す。パスには、screenshot のツールの結果に出たパスを使う。本文の画像のパスは、アップロード後の URL に書き換わる。
body.md は画像と同じ `.playwright-mcp/` に置く。gh は本文の `./<名前>.png` を body.md のディレクトリを起点に解く。
置き場所が違うと参照が書き換わらず、画像は本文の末尾に足される。

`gh pr edit` が PR を引けずに止まったときだけ、Actions に画像を載せさせる。クラウドのスレッドでは、セッションのプロキシが GraphQL を 403 で止める。
リポに `pecot-github-ops.yml` と secret `PECOT_ATTACH_TOKEN` が要る。どちらかが無ければ、`screenshot` に理由を書く。

1. 次を打って画像を送り、標準出力の `id=` の ID を控える。本文の `./<名前>.png` の参照は、PR の本文から消さない
   - クラウドで保存した本文では、参照の先頭の `!` が落ちてリンクになる。`pr-attach` が画像の記法に戻すので、本文を直さない

   ```bash
   node <このスキルの base directory>/scripts/push-attach.cjs .playwright-mcp/<名前>.png ...
   ```

2. 公式の GitHub の MCP の `actions_run_trigger` で、`pecot-github-ops.yml` を起動する。inputs は次のとおり
   - `operation`: `pr-attach`
   - `request_id`: 控えた ID
   - `params`: `{"pr":<PR番号>,"branch":"pecot-attach/<ID>"}`
3. `actions_list` で、run-name が `pecot github-ops pr-attach <ID>` の run を探し、終わるまで待つ
4. `get_job_logs` で `PECOT_RESULT` の行を読む。`ok: false` なら、error の kind と message を利用者に伝えて止まる

### Closing Issue キーワードと Epic

- テンプレの `Closes #` には、`session_show` の作業中の Issue の番号を書く
- Epic 番号 (sub-issue を持つ親 Issue) を書かない。作業中の Issue が Epic なら、この行を消す
- ブランチ名末尾の `<num>` も sub-issue 番号にする

### Step 4: CI を待って直す

CI の結果を待つ間も、base とのコンフリクトと merge queue からの外れを同時に待つ。CI を待つ間に base が進んでも、言われる前に直すためだ。

次のコマンドで待ち、CI が終わるか PR の状態が変わったときに 1 語だけ出す。Claude Code では Bash の background 実行、GitHub Copilot CLI では非同期の実行で動かす。

待ちのスクリプトは、公式の MCP でなく `gh` で PR を読む。公式の MCP に、PR が merge queue に入っているかを返すツールと、状態の変化を知らせる仕組みが無いからだ。バックグラウンドのスクリプトからは、MCP のツールを呼べない。

```bash
node <このスキルの base directory>/scripts/wait-pr.cjs ci <PR の URL>
```

間隔と上限は [Step 6](#step-6-マージを待ち受けて片付ける) と同じで、3 つ目と 4 つ目の引数に秒で渡せる。

Claude Code では、待ちが終わった通知を受けたら、出力を読む前に、Skill ツールで `pecot-w:w-pr` を引数 `resume` で呼び直す。allowed-tools の許可は、スキルを呼んだターンの間だけ続き、通知で始まるターンでは切れているからだ。GitHub Copilot CLI では呼び直さず、そのまま出力を読む。

| 出力 | 次の手順 |
|---|---|
| `CI_PASSED` | Step 5 へ進む |
| `CI_FAILED` | 公式の MCP の `pull_request_read`（`get_check_runs`）で落ちた check を、`get_job_logs` でそのログを読む。PR の変更が原因のものだけ直して push し、待ち直す。関係ない失敗は利用者に伝えて止まる |
| `NO_CHECKS` | CI の無いリポとみなし、その旨を伝えて Step 5 へ進む |
| `CONFLICTING` | base とコンフリクトした。スタックしたブランチでは `pr_restack` でスタックし直し、ほかのブランチでは base の新しい先頭へ rebase して push し、待ち直す |
| `DEQUEUED`・`MERGED`・`CLOSED` | Step 6 の表の同じ行に従う |
| `TIMEOUT` | 同じコマンドで待ち直す |
| `待ち受けを続けられません:` で始まる | 文を利用者に伝えて止まる |

CI の失敗を直すのは 3 回まで。超えたら状況を利用者に伝えて止まる。コンフリクトの直しは、この回数に数えない。

### Step 5: レビューの指摘に対応

CI が通ったら、PR に付いたレビューの指摘に対応する。自動レビューのワークフローがあるリポでは、その job も Step 4 の checks の 1 つとして待ち終えている。

対応する指摘は、次の 2 つから読む。

- PR の未解決のスレッドのうち、先頭が `^\*\*F-\d+` に一致するもの
- 後ろに `review-resolution` の無い `review-findings`

公式の MCP の `pull_request_read` で、PR のスレッドとコメントを読む。スレッドは `get_review_comments`、`review-findings` などのコメントは `get_comments` で読む。
指摘が無ければ、その旨を伝えて [Step 6](#step-6-マージを待ち受けて片付ける) へ進む。

最新の `review-findings` の Disposition で「直った」とされた F-NN は、採否を決める対象にしない。スレッドを resolve する対象にし、`review-resolution` の Applied に書く。

#### F-NN とスレッド ID の対応表

`get_review_comments` の結果から、先頭コメントが `**F-NN**` で始まるスレッドを拾い、F-NN ごとに次の 3 つを控える。結果が複数ページに分かれるときは、`after` に前のページの `endCursor` を渡して全ページを読む。

| 控えるもの | 結果の欄 |
|---|---|
| スレッドの ID | スレッドの `id`（`PRRT_` で始まる） |
| 解決済みか | スレッドの `is_resolved` |
| 先頭コメントの番号 | 先頭コメントの `html_url` の末尾の `#discussion_r<番号>` の番号 |

#### 採否を決める

採否を利用者に聞かない。main が F-NN ごとに「対応」か「対応不要」かを決め、対応を終えてから報告する。

- 既定は「対応」にする。指摘の示す箇所と仕様を読んで確かめてから直す
- 「対応不要」にするのは、次のどれかに当たるときだけにする
  - 指摘が事実と違う
  - 直すと、承認された計画や Issue の決めた仕様・挙動と食い違う
  - `review-findings` の Disposition が「対応不要」で、その理由に同意する
- 「対応不要」の理由には、確かめた根拠（読んだコード・仕様の文・計画）を添える
- 保留や別 Issue への先送りにしない

指摘が 0 件の `review-findings` なら、`review-resolution` を 0 件の文言で投稿し、この後の修正と resolve を飛ばして Step 6 へ進む。

#### 採用分を直し、main がコミット

まず、次の 2 つを行う。

1. resource `pecot-template://comment/review-resolution` を読み、PR 宛てのテンプレのファイルを作る。frontmatter の `owner`・`repo`・`issue_number` には PR を書く。Decision 節と Declined 節を埋める。

2. 対応不要の F-NN のスレッドに、理由を返信する。公式の MCP の `add_reply_to_pull_request_comment` に、対応表の先頭コメントの番号を `commentId` で渡す。`pullNumber` と `body` も渡す

「対応」の F-NN が無ければ、ここで「スレッドを一括 resolve」へ進む。採用分があれば、main が直すことを基本にする。

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
流し直した結果で、Verified を書き直す。コメントに分けたログは、[本文に収まらないログ](#本文に収まらないログ) の手順で新しいコメントに載せ、Verified のリンクを差し替える。

#### スレッドを一括 resolve

`get_review_comments` を読み直し、次をすべて満たすスレッドを、採用分・対応不要分とも resolve する。

- 先頭コメントが `^\*\*F-\d+` に一致する
- `is_resolved` が false
- 今回の対応表に載っている

スレッドごとに、公式の MCP の `pull_request_review_write` を `method: resolve_thread` で呼び、スレッドの ID を `threadId` で渡す。
すべて呼んだら `get_review_comments` を読み直し、対象のスレッドがすべて `is_resolved` になったことを確かめる。残ったスレッドだけを resolve し直す。

#### `review-resolution` を投稿

書き始めたファイルを、テンプレのガイドに従って仕上げて投稿する。コミットの sha と、コミットメッセージにある対応内容は本文に書かない。投稿は、pecot-workflow の MCP ツール `issue_comment_check` に通してから、公式の MCP の `add_issue_comment` で行う。

対応を終えたら、チャットに `review-resolution` の本文をそのまま示して報告する。

修正を push したら、Step 4 に戻って CI を待つ。push する修正が無ければ、Step 6 へ進む。

修正を push したあと、pecot-workflow の MCP ツール `session_show` を使って、子 PR があるかを確かめる。あれば、その PR の作業ディレクトリで `pr_restack` が要る旨を、チャットの報告に入れる。子 PR の作業ディレクトリには入らない。

#### 注意

- 採否は main が決め、途中で利用者に確かめない。「対応不要」にした F-NN は、スレッドの返信と Declined に理由を残す。
- 返信と resolve は、`**F-NN**` で始まるスレッドに限る。

### Step 6: マージを待ち受けて片付ける

マージは、利用者が GitHub の画面で行う。PR がマージされるか閉じられるまで待ち、マージされたらその場で片付ける。

次のコマンドで待ち、PR の状態が変わったときに 1 語だけ出す。Step 4 と同じく、Claude Code では Bash の background 実行、GitHub Copilot CLI では非同期の実行で動かす。

```bash
node <このスキルの base directory>/scripts/wait-pr.cjs merge <PR の URL>
```

待ち方と URL だけを渡すと、60 秒おきに PR を読み、25 分で切り上げる。間隔と上限は、3 つ目と 4 つ目の引数に秒で渡せる。
25 分は、Claude Code の background 実行の既定の上限（30 分）より短い。

Claude Code では、待ちが終わった通知を受けたら、Step 4 と同じく Skill ツールで `pecot-w:w-pr` を引数 `resume` で呼び直してから出力に合う行を実行する。待ち直したときも、待ちが終わるたびに呼び直す。GitHub Copilot CLI では呼び直さず、そのまま出力に合う行を実行する。

| 出力 | 次の手順 |
|---|---|
| `MERGED` | [マージされた後の片付け](references/after-merge.md) に従って片付ける |
| `CLOSED` | マージされずに閉じられた旨を利用者に伝えて止まる。片付けない |
| `CONFLICTING` | base とコンフリクトした。Step 4 に戻り、スタックし直すか base へ rebase してから CI とレビューの指摘に対応し、ここで待ち直す |
| `CI_FAILED` | CI が通った後で、再実行や push により失敗した。Step 4 に戻り、落ちた check を直してから CI とレビューの指摘に対応し、ここで待ち直す |
| `DEQUEUED` | merge queue のチェックが落ちたか、コンフリクトで queue から外された。スタックの子 PR では、親 PR が先にマージされて外れることもある。Step 4 に戻り、原因を直してから待ち直す。直す箇所が無ければ、もう一度押すよう利用者に伝えて待ち直す |
| `TIMEOUT` | 同じコマンドで待ち直す |
| `待ち受けを続けられません:` で始まる | 文を利用者に伝えて止まる |

上限で止められて何も出さずに終わったときも、同じコマンドで待ち直す。
