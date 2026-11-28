---
name: w-breakdown
description: |
  Epicをspeckitフローでサブタスクに分解します。
  Use when the user has an Epic and wants to break it down via the speckit workflow (specify → clarify → plan → tasks). Files a breakdown task under the Epic, works on its linked branch, and runs the speckit workflow (specify → clarify → plan → tasks), committing and pushing each approved step.
  Do NOT use for simple subtask creation (use w-ready), batch conversion (use w-issueize), or new Epics (use w-backlog).
when_to_use: "Epic をサブタスクに分解したい、speckit で計画を立てたい"
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__session_finish
---

# Epic分解：speckit 工程の逐次実行

Epic の内容を読み取り、main が speckit コマンド（specify → clarify → plan → tasks）を
逐次実行して分解する。分解の作業は、Epic の下のタスクとして起票し、そのタスクに紐づいたブランチで進める。
speckit の成果物（`specs/` 配下のファイル）は、**w-breakdown を実行したリポジトリ** のそのブランチに作る。ただしプロジェクトの集約リポ（`aggregation_repo`）に
**ロードマップリポ** が設定されている場合、そのロードマップリポでのみ実行を許可
する。ロードマップリポ設定があるのに別リポで起動された場合は中止し、ロードマップリポでの
再実行を案内する。

各工程の間で main は AskUserQuestion でユーザー承認を取り、承認を得てから次工程へ進む。

## 手順

### Step 1: ボードを確認する

pecot-workflow の MCP ツール `project_get` を `key` なしで呼び、プロジェクトの設定（集約リポ・登録したリポの開発ブランチ）を確かめる。

### Step 2: 成果物作成先の決定（ロードマップリポチェック）

Step 1 で確かめた集約リポ（`aggregation_repo`）と、CWD のリポを比べる。

CWD のリポは、pecot-workflow の MCP ツール `session_show` の `repository` で読む。git の remote から求めた `owner/repo` だ。

`repository` が無い場合（GitHub remote 未設定など）は、CWD のリポを自動判定できないとユーザーに伝え、現在地が想定リポか AskUserQuestion で確認する。

判定:

- **`project.aggregation_repo` が null** → CWD のリポで成果物を作る前提で進む
- **`project.aggregation_repo` が `<owner/repo>`** かつ **CWD == その値** → そのまま進む
- **`project.aggregation_repo` が `<owner/repo>`** かつ **CWD が異なる** → 中止し、次の文をユーザーに案内する

  > このプロジェクトではロードマップリポ `<owner/repo>` が設定されている。
  > w-breakdown はロードマップリポでのみ実行できる。`<owner/repo>` のワークツリーで再実行すること。

### Step 3: 対象Epicを特定

ユーザーの指示から対象Epicを特定する。Epic番号・タイトル指定なら直接使用、不明な場合は AskUserQuestion で Backlog 内の Epic を選択させる。公式の MCP の `issue_read`（`get`・`get_sub_issues`）で、その Epic と sub-issue を読む。

`owner/repo` は Epic Issue が置かれているリポ。speckit 成果物の作成先は Step 2 で確定済。

### Step 4: 分解のタスクを起票する

Step 3 で読んだ Epic の sub-issue から、OPEN の分解のタスクを、次の順で探す。

1. 題に「speckit で分解する:」を含む OPEN の sub-issue を探す。見つかれば、それを分解のタスクとする
2. 見つからなければ、ほかの OPEN の sub-issue の紐づいたブランチを確かめる。名前が `feat/breakdown-` で始まるブランチを持つものを、分解のタスクとする

紐づいたブランチは、公式の MCP の `list_branches` で、そのタスクのリポのブランチを読んで確かめる。pecot のブランチは、名前が `/<Issue 番号>` で終わる。

| 見つかったもの | すること |
|---|---|
| タスクと、紐づいたブランチ | 起票しない。そのブランチを checkout する。Step 5 で再開として扱う |
| タスクだけ（ブランチが無い） | 起票しない。そのタスクで作業を始める |
| どちらも無い | 起票し、作業を始める |

起票は、テンプレートを通さない自由形式で行う。手順は [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「Issue を作る」のとおり。
pecot-workflow の MCP ツール `issue_check` に `template` を渡さずに通し、公式の MCP の `issue_write` で作る。値は次のとおり。

- 種類: `kind: task`
- `parent_owner`・`parent_repo`・`parent_issue_number`: Step 3 で読んだ Epic
- `owner`・`repo`: Step 2 で決めたリポ
- `body`: 1 行目を `speckit で分解する: <Epic の題>` にする。題は 1 行目の先頭の 50 文字から作るので、目印を先頭に置く。2 行目からは、分解する範囲を 1〜2 行で書く
- `title`: 本文の 1 行目から作る。形は `issue_check` が確かめる

作業は、[GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「作業を始める」の手順で始める。
`branch_check` に通してから、github-ops の `link-branch` でブランチを作る。ブランチの名前は `feat/breakdown-<英語の短い名前>/<タスクの番号>` にする。
続けて pecot-workflow の MCP ツール `session_start` を使って手元に作業を記録し、タスクのカードを `Active` へ動かす。
チェックやツールが止まったら、エラーの案内を利用者に示して止まる。

`session_start` の結果に `leftovers` があれば、前にマージされた PR の手元の片付けが残っている。checkout の前に、PR ごとに [マージされた後の片付け](references/after-merge.md) の「片付け」の節を行う。手元が wt ブランチに戻る。

checkout の前に、`git status --porcelain` が空であることを確かめる。空でなければ、commit・stash・破棄のどれにするかを利用者に確かめる。

```bash
git fetch origin
git checkout <ブランチ名>
```

### Step 5: speckit 工程の準備

工程の承認の後の commit は、利用者のリポの commit の規約に従い、メッセージに工程の名前（specify・clarify・plan・tasks）を入れる。
規約が無ければ、`docs: #<タスクの番号> <工程の名前> の成果物` にする。再開では、このメッセージで済んだ工程を見分ける。

Step 4 で既存のタスクを使ったときは、再開として次を行う。新しく起票したときは、この段落を飛ばす。

1. 対象の spec のディレクトリを、次のコマンドで求める。`<開発ブランチ>` は Step 1 で確かめた `develop_branch` だ。`develop_branch` が null なら止め、pecot-workflow の MCP ツール `project_link` で設定するよう利用者に案内する

   ```bash
   git diff --name-only origin/<開発ブランチ>...HEAD -- specs/
   ```

2. 出たファイルの `specs/<NNN-名前>/` を対象にする。1 つも無ければ、新しく始める。2 つ以上あれば、AskUserQuestion で選ばせる
3. `.specify/feature.json` が無いか、別のディレクトリを指すときは、次の形に書き直す。speckit 本体は、このファイルで対象のディレクトリを求める

   ```json
   {
     "feature_directory": "specs/<NNN-名前>"
   }
   ```

4. 済んだ工程を、`git log --format=%s origin/<開発ブランチ>..HEAD -- specs/<NNN-名前>/` で求める。新しいほうから読み、最初に工程の名前が出た commit で決める。続ける場所は次のとおり

   | 最後に承認した工程 | 続ける場所 |
   |---|---|
   | tasks | Step 10 |
   | plan | Step 8 |
   | clarify | Step 7 の `/speckit.plan` |
   | specify | Step 7 の `/speckit.clarify` |
   | 無い | Step 6 の承認（spec.md が無ければ `/speckit.specify` から） |

Epic の番号・タイトル・本文・背景を読み取り、specify への入力として main 自身が整理する。
工程ごとの責任者（spec / plan / tasks）は担当工程の概念として存在するが、本 single フローでは
main がそれぞれの責任者役を担って各コマンドを実行する。

整理する情報:

- Epic 番号（`#NNN`）
- 目的・スコープ
- 要件（Issue 本文から抽出）
- 背景情報（親 Epic や関連 Issue の内容）

### Step 6: specify 実行

main が `/speckit.specify` を実行する。Epic の内容から目的・スコープ・要件・背景情報・
Epic 番号を抽出し、`/speckit.specify` の引数として渡す。

speckit の git 拡張は、`before_specify` の hook でブランチを作る。今のブランチのまま進めるため、次の指示を足す。

- 足す条件: `.specify/extensions.yml` の `hooks.before_specify` に `speckit.git.feature` の項目がある。その `enabled` は `false` でない
- 足す場所: `/speckit.specify` の引数の末尾
- `<ブランチ名>` は、`git branch --show-current` の値に置き換える
- 条件に当たらないリポでは、何も足さない

```text
次の指示は hook の動かし方で、機能の説明ではない。spec には書かない。before_specify の hook（speckit.git.feature）では、新しいブランチを作らない。GIT_BRANCH_NAME に <ブランチ名> を渡し、--allow-existing-branch を付けて create-new-feature-branch.sh --json を打つ。bash の例: GIT_BRANCH_NAME="<ブランチ名>" .specify/extensions/git/scripts/bash/create-new-feature-branch.sh --json --allow-existing-branch --short-name "<短い名前>" "<機能の説明>"。PowerShell では $env:GIT_BRANCH_NAME と -AllowExistingBranch を使う。
```

実行後、AskUserQuestion でユーザー承認を取る（「次に進む」「修正を指示する」「やり直す」）。
承認を得たら、`specs/<NNN-名前>/` を commit し、タスクのブランチへ push する。別の clone でも、Step 5 の再開で続けられるようにする。

### Step 7: clarify → plan を逐次実行

main が各工程を順に実行する。各工程完了後に AskUserQuestion で以下の承認 3 択を提示し、
承認を得たら次工程へ進む。前工程の承認を得るまでは、次工程へ進まない。
承認を得るたびに、`specs/<NNN-名前>/` を commit し、タスクのブランチへ push する。

| 選択 | 意味 |
|------|------|
| 次に進む | 次工程へ |
| 修正を指示する | main が修正内容を指定して再実行 |
| やり直す | 工程を最初からやり直す |

工程の順序: `/speckit.clarify` → `/speckit.plan`

plan の承認を得たら、Step 8 へ進む。

### Step 8: tasks 実行

main が `/speckit.tasks` を実行する。引数には、次のコードブロックの中身をそのまま貼る。言い換えない。要約もしない。
spec-kit のテンプレートは変えない。前提の表の形は、この引数で渡す。

```text
tasks.md の `## Dependencies & Execution Order` の下にある `### Phase Dependencies` に、フェーズの前提を次の 4 列の表で書く。

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | スタック可 | Phase 2 の処理が、Phase 1 で足す設定のキーを読む |
| 3 | 2 | スタック不可 | Phase 3 の確認に、既定のブランチから配られる action を使う |

上の 2 行は書き方の例だ。tasks.md には写さず、この機能のフェーズの前提を書く。

書き方の決まり:
- 1 行が、フェーズと前提の 1 組だ。前提が 2 つあるフェーズは 2 行になる
- 前提の無いフェーズは、表に書かない
- `Phase` と `前提` には、フェーズの番号だけを書く
- `種類` には「スタック可」か「スタック不可」のどちらかを書く
- `理由` は、すべての行に書く。「スタック不可」の行には、開発ブランチに入っていないと進められない訳を書く
- 前提にするのは、フェーズ全体の着手を止める依存だけだ。一部のタスクだけが待つ依存は、タスクの行に注記で書く
- 直接の前提だけを書く。Phase 3 が 2 を待ち、2 が 1 を待つとき、Phase 3 の行に 1 は書かない

開発ブランチは、フェーズの PR のマージ先のブランチだ。試験環境は、開発ブランチに入れる前の変更を動かして確かめる場所だ。プロジェクトの文書に、その場所で動かす手順があるときだけ使う。無いときは、手元のブランチだけで判断する。

種類は、次の 2 つの問いで決める:
- 前提の変更を、手元のブランチか試験環境で動かして、このフェーズの実装と確認ができる。このときは「スタック可」
- 前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、このフェーズの実装か確認ができない。このときは「スタック不可」

「スタック不可」になる例:
- 既定のブランチから配られるものを使う（action・公開したパッケージ）
- リリースの後の実物で確かめる
- 開発ブランチの CI やリリースのワークフローが、前提の変更を使う

ほかの決まり:
- テンプレートにある `### Phase Dependencies` の箇条書きは残さない。この表に置き換える
- `### Phase Dependencies` の見出しが無ければ、`## Dependencies & Execution Order` の下に作る
- 最後のフェーズにも番号を振る。「Final Phase」や `Phase N` のままにしない
- 前提を持つフェーズが 1 つも無いときは、見出しの行と区切りの行だけの表を書く
```

### Step 9: 前提の表を確かめる

main が、できた tasks.md の `### Phase Dependencies` を読み、次の 4 つを確かめる。

1. `| Phase | 前提 | 種類 | 理由 |` の 4 列の表がある
2. `Phase` と `前提` が数字だけで、どれも tasks.md のフェーズの見出し（`## Phase <番号>:`）にある
3. `種類` の値が、どの行も「スタック可」か「スタック不可」
4. すべての行に `理由` がある

見出しの行と区切りの行だけの表は、前提を持つフェーズが無い表として通す。

通らないときの扱いは、確かめで分かれる。tasks の工程をやり直すものと、ユーザーに確かめるものがある。

1〜3 が通らないときと、「スタック可」の行の理由が空のときは、tasks の工程（Step 8）をやり直す。やり直すときは、Step 8 のコードブロックをもう一度そのまま貼り、その後ろに、通らなかった確かめと箇所を 1 行足して `/speckit.tasks` を実行する。やり直しは 1 回まで。やり直しても通らないときは、外れた箇所をユーザーに示して判断を仰ぐ。

「スタック不可」の行の理由が空のときは、開発ブランチに入っていないと進められない訳をユーザーに確かめる。エージェントが理由を作らない。ユーザーが答えた文を、main がその行の `理由` のセルにそのまま書く。tasks の工程はやり直さない。やり直しの回数に数えない。tasks の工程をやり直したときは、やり直した後の表でこの確かめをする。

確かめが通ったら、AskUserQuestion で Step 7 と同じ承認 3 択（次に進む・修正を指示する・やり直す）を提示する。
「修正を指示する」「やり直す」で tasks の工程をもう一度実行するときも、Step 8 のコードブロックをもう一度そのまま貼る。「修正を指示する」なら、その後ろに直す点を足す。実行した後は、この Step の確かめからやり直す。
承認を得たら、`specs/<NNN-名前>/` を commit し、タスクのブランチへ push する。

analyze（`/speckit.analyze`）は読み取り専用工程のため任意。成果物の確認・検証が要るときに実行する。

### Step 10: PR と Issue 化

w-breakdown はここで終える。利用者に、次の 2 つを順に案内する。

1. `/pecot-w:w-pr` で、分解のタスクを閉じる PR を出す。PR が `specs/<NNN-名前>/` を開発ブランチに入れる
2. PR のマージの後に、`/pecot-w:w-issueize` で各フェーズを Issue として一括登録する。フェーズの Issue の実装で w-active が tasks.md に `[x]` を付けるには、spec の一式が開発ブランチに要る

w-pr は、このスキルから起動しない。PR を出すかは利用者が決める。
