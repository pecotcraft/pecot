---
name: w-merge
description: |
  PRをマージしブランチ削除・後処理を実行します。
  Use when the user wants to merge a PR and run post-merge cleanup (branch delete, worktree switch-back, pull latest). Triggers: "merge", "merge the PR".
  Do NOT use for creating PRs (use w-pr) or release merges from develop to main (use w-release).
when_to_use: "PR をマージしたい、マージ後のブランチ削除と後片付けをしたい"
---

# PRマージ

PRをマージし、マージ後にブランチ削除とワークツリー環境の後処理を実行します。

## 手順

### Step 1: PR状態確認

引数 `owner/repo/PR番号` 形式（例: `acme-labs/ai-engineer-starter-kit/759`）を受け取る。省略された場合は、直前の会話から対象 PR が一意に特定できる（同じセッションで作成・レビューした PR が 1 件しかない等）ならそれを採用して進んでよい。曖昧な場合にのみユーザーに確認する。

`pr_show` を `pr_ref: "<owner>/<repo>/<PR番号>"` で呼ぶ。

PRがマージ可能な状態であることを確認する。続いて、ローカルに取り込んでいない変更がないかを確認する。`pr_check` を `directory: "."` で呼ぶ。

結果に `exit code: 1` か `exit code: 2` の行が出たら、結果を見て解決し、呼び直してからマージに進む。

### Step 2: マージと片付け

#### 2.1 マージ

```bash
gh pr merge <PR番号> --repo <owner>/<repo> --squash
```

- merge queue のないリポでは、その場でマージされる
- merge queue のあるリポでは、PR を queue に入れて終わる。マージはこの後に GitHub が行う
- 必須チェックが終わっていないときは、auto-merge の予約になる

#### 2.2 マージを待つ

Claude Code では Monitor ツールで、このスキルのディレクトリの `scripts/merge-wait.sh` を動かし、抜けるまで待つ。`<owner>` などは置き換える。

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/merge-wait.sh" <owner>/<repo>/<PR番号>
```

- Monitor の期限（timeout_ms）は、最長の 30 分（1800000）で渡す。省くと既定の 5 分で打ち切られる。`-p`（非対話）の実行では、上限が 10 分になる
- 期限の通知が来たら、スクリプトは止まっているので、同じコマンドで 2.2 を起動し直す
- 待つのは、merge queue の中にいるときと、auto-merge の予約があってチェックが終わっていないときだけ。ほかの状態は理由を出して抜ける
- 状態が 15 分変わらないと `stalled` で抜ける。merge queue の中や、1 本の長いジョブが続くときにも出る。CI や queue が 15 分を超えるリポでは、`--stall-minutes <分>` を付けて起動する。Monitor の期限（最長 30 分）より長くしても、期限で先に止まるので、起動し直して待つ

抜けたときの出力は、1 行目が理由、2 行目が最後の状態になる。`blocked` と `stalled` のときだけ、3 行目以降が付く。中身は、base のルールの種類と、code scanning の開いているアラートの番号。

```
merge-wait: blocked
state: OPEN queue=false auto-merge=true mergeable=MERGEABLE mergeStateStatus=BLOCKED required=passed checks-pending=0
rules(main): pull_request, required_status_checks, merge_queue, code_scanning
code-scanning open alerts: #28 #29
```

1 行目の理由に合う行を実行する。片付けへ進むのは `merged` だけ。

| 1 行目の理由 | 次の手順 |
|---|---|
| `merged` | 2.3 へ進む |
| `closed` | ユーザーに伝えて止まる |
| `conflicting` | ユーザーに伝える。`git fetch origin main` の後に `git merge origin/main` で取り込み直し、コンフリクトを直して push する |
| `required-failed` | `gh pr checks <PR番号> --repo <owner>/<repo> --required` で落ちたチェックを読んでユーザーに伝える。直して push する |
| `not-queued` | queue から外れている。落ちたチェックがあれば直して push し、2.1 からやり直す。無ければ理由をユーザーに伝えて止まる |
| `blocked` | 列挙に無い状態はすべてここに来る。2 行目の `mergeStateStatus` を先に読み、止まった理由をユーザーに伝えて止まる。`session_finish` は呼ばない |
| `stalled` | 状態が変わらないまま 15 分を超えた。2 行目と 3 行目以降をユーザーに伝え、進んでいる見込みなら待ち直しを勧める |
| `query-failed` | `gh` が 3 回続けて失敗した。出力の `gh` のエラーをユーザーに伝えて止まる |

- `conflicting` と `required-failed` で push した後は、2 行目の `auto-merge=` を見る。`true`（auto-merge の予約が残っている）なら 2.2 から、`false` なら 2.1 からやり直す
- `not-queued` の落ちたチェックは、`gh pr checks <PR番号> --repo <owner>/<repo>` で読む。落ちたチェックが無いときの理由は、auto-merge の予約の取り消しなどが考えられる
- `blocked` の `mergeStateStatus` は、`BEHIND` が base より遅れている、`DRAFT` が draft、`BLOCKED` がルールや承認が満たされていない、を指す。調べるコマンドは次のとおり
  - アラート: `gh api repos/<owner>/<repo>/code-scanning/alerts/<番号>`
  - 承認: `gh pr view <PR番号> --repo <owner>/<repo> --json reviewDecision`
- `stalled` では、2 行目の `queue=` と `checks-pending=`、3 行目以降のルールとアラートを伝える。`queue=true` か `checks-pending` が 1 以上なら、進んでいる見込みなので待ち直しを勧める
- GitHub Copilot CLI など Monitor のない環境では、数分おいて 2.3 を呼び直す。未マージなら `exit code: 1` で何もしない

#### 2.3 片付け

`session_finish` を `pr_ref: "<owner>/<repo>/<PR番号>"`・`delete_branch: true` で呼ぶ。

> 注意: マージ後の片付けは必ず `session_finish` で行う。`gh pr merge` の `--delete-branch` は使わない（ローカルの片付けとフラグの削除が漏れる）

`session_finish` は PR が MERGED のときだけ動く。それ以外は何もせず `exit code: 1` で終わる。

**入力**:

- `delete_branch`: リモートブランチを削除する（ここでは `true` を渡す）
- `dry_run`: ドライラン（実際には片付けない）
- `skip_local_cleanup`: ローカルの後処理をスキップする

### Step 3: ローカルクリーンアップの確認

`session_finish` が自動的に以下を実行する。

- WT環境では、wtXブランチへ切替 → `git pull <remote> <開発ブランチ>`（remote は origin、無ければ最初の remote）→ ローカルフィーチャーブランチ削除
- 通常環境では、開発ブランチへ切替 → `git pull` → ローカルフィーチャーブランチ削除
- クロスリポでは、現在のリポとPRのリポが異なる場合、ローカルクリーンアップはスキップされる

結果に `warning:` の行があれば以下で手動対応:

- ワーキングツリーが汚れている場合: 変更を一時的な WIP commit で退避してから再実行する。stash は全ワークツリーで共有されるので、使うときは `git stash push -u -m "<名前>"` で名前を付け、戻すときもその entry を指定する
- `skip_local_cleanup: true` でローカル後処理をスキップし、手動で対応

> 注意: ワークツリー環境では`wtX`ブランチ（ベースブランチ）を削除しない。`cd`コマンドで他のワークツリーやmainワークツリーに移動しない

詳細: [ワークツリー環境での処理](references/worktree-handling.md)

### Step 4: 実装差分分析・Epicコメント

マージしたPRの実装内容と、サブタスクIssueに記載された実装計画を比較し、差分をEpicにコメントする。

スキップ条件は次のとおりで、いずれかに該当する場合は Step 4-5 をスキップする。

- `session_finish` の結果に `closed: Issue #<n>` の行がない（Issue未紐付けPR）
- `closed:` の行のIssueに `Parent:` フィールドがない（独立タスク、フォローアップ修正等）

#### 4.1 サブタスクIssueの確認

`session_finish` の結果の `closed: Issue #<n>` の行からIssue番号を取得し、Issueを読む。`issue_show` を `issue_ref: "<owner>/<repo>/<issue_number>"` で呼ぶ。

- `Parent:` フィールドから親EpicのIssue番号を取得 → なければ **Step 4-5 をスキップ**

#### 4.2 実装内容の把握

マージされたPRの変更内容を把握する。ここで集めた事実は 4.3 の Variance
（計画と実績の差分）を判断するために使う。変更ファイル一覧そのものはコメント本文に転記しない
（PR の Files changed が見せる）。

- PRの変更ファイル一覧（git logから）
- 実際に変更されたモジュール・関数

#### 4.3 差分サマリーの生成

Issue本文の計画と実際の変更を比較し、テンプレ実体に従ってサマリーを生成する。`issue_comment` を `prepare: true`・`template: "merge-diff"`・`issue: "<owner>/<repo>/<epic番号>"` で呼ぶ。

- 出力されたファイル冒頭の `<!-- 読者:/書き方: -->` コメントに従い、必須見出しを維持したまま本文を埋める
- 見出しレベル・記号・節構成はテンプレを基準とする。SKILL.md にはフォーマット例示を持たない

#### 4.4 Epicにコメント投稿

4.3 で編集したファイルを投稿する。`issue_comment` を `file: "<編集後ファイル>"` で呼ぶ。

> 注意: `issue_comment` 以外の方法（`gh` や GitHub の MCP など）でIssueコメントを投稿しない

差分がまったくない（計画通り）の場合も、「計画通り完了」のコメントを投稿する。

### Step 5: speckit後続フェーズ通知（条件付き）

**この工程はspeckit由来のタスクの場合のみ実行する。**

#### speckit由来の判定条件

以下のいずれかに該当する場合、speckit由来と判定:

- Issue本文に `.specify/` パスへの言及がある
- 親Epicの他のサブタスクがspeckit形式（`[Task] #XXX-NN:` または枝付きの `[Task] #XXX-NNa:` 形式でorder付き、かつ `specs/` への言及がある）

#### 5.1 後続フェーズの特定

`issue_show` を `issue_ref: "<owner>/<repo>/<epic番号>"` で呼ぶ。

`Sub-issues:` セクションから次を行う。

1. 現在のタスクを特定（タイトルの `#XXX-NN` で識別。枝の文字がある場合は `#XXX-NNa` まで含める）
2. 現在のタスク以外の OPEN なサブタスクを抽出（orderの大小は問わない）

#### 5.2 影響コメントの投稿

後続フェーズに影響する変更がある場合、テンプレ実体に従って影響コメントを生成・投稿する。

1. `issue_comment` を `prepare: true`・`template: "precede-notify"`・`issue: "<owner>/<repo>/<後続issue番号>"` で呼ぶ
2. 出力された `.pecot/tmp/output/` 配下の md を編集する
3. `issue_comment` を `file: "<編集後ファイル>"` で呼ぶ

- フォーマットはテンプレ実体に従う。SKILL.md にはフォーマット例示を持たない

影響がない場合はコメント不要。
