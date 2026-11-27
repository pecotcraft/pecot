---
name: w-issueize
description: |
  実装計画の各フェーズをIssueに一括登録します。
  Use when the user has a plan file (e.g. speckit's tasks.md) and wants each phase converted into GitHub Issues in bulk under a parent Epic, placed in Ready or Blocked by their prerequisites.
  Do NOT use for a single subtask (use w-ready), plan creation (use speckit.tasks), or starting implementation (use w-active).
when_to_use: "tasks.md の各フェーズを Issue にまとめて登録したい、実装計画を一括で Issue 化したい"
---

# 実装計画のIssue化

実装計画ファイル（tasks.md など）を読み取り、各フェーズを親Epic配下のサブタスクIssueとして一括作成する。ブランチ作成・実装作業は行わない。Issue作成後は `/pecot-w:w-active` で1件ずつ実装する。

## 手順

### Step 1: 対象Epicと実装計画ファイルを特定する

ユーザーの指示から親Epic番号と実装計画ファイル（例: `specs/NNN-*/tasks.md`）のパスを特定する。不明な場合は AskUserQuestion で確認する。

このとき、次の変数を確定する。確定した値は、後続 Step で Artifacts セクションに転記する。

- `SPECKIT_DIR`: speckit 一式が置かれているディレクトリ（例: `specs/263-plan-mode-reminder/`）。aist-roadmap など外部リポにある場合は `owner/repo:specs/NNN-*/` 形式で表す。
- `TASKS_PATH`: 受け取った tasks.md の実パス

公式の MCP の `issue_read`（`get`・`get_sub_issues`）で、親 Epic と sub-issue を読む。

### Step 2: フェーズ構造と前提を把握する

tasks.md を読み取り、Phase 1, Phase 2 ... の区切り・各フェーズのタイトル／目的／Tasks／Checkpoint／Independent Test を抽出する。同じディレクトリに plan.md や data-model.md などの補足ドキュメントがあれば文脈として合わせて読む。

フェーズの前提は、tasks.md の `### Phase Dependencies` の 4 列の表（Phase・前提・種類・理由）から読む。1 行が、フェーズと前提の 1 組。`[P]` はタスク単位の印なので使わない。
見出しの行と区切りの行だけの表は、「前提が無い」と読む。文から前提を読まない。
前提にするのは、フェーズ全体の着手を止める依存だけ。一部のタスクだけが待つ依存は前提に入れない。tasks.md のタスクに付いた依存の注記は、タスクの行ごと Tasks に写る。

4 列の表が無い tasks.md は、次のように扱う。

1. `Phase Dependencies`・`User Story Dependencies`・`Parallel Opportunities` の文から、フェーズの前提を読む
2. 種類はすべて「スタック可」とする
3. 読んだ結果を 4 列の表にしてユーザーに示し、表が無かった旨を伝える
4. ユーザーが種類を変えるよう指示したら、その行を直す

Issue 化済みのフェーズは、同じ親Epicの既存サブタスクの本文の Tasks（T 番号）を tasks.md の各フェーズと比べて見分ける（**見分けるためだけに参照。Epic進捗の評価はしない**）。フェーズの Tasks が既存サブタスクの Tasks に写っていれば、そのフェーズは済とする。済のフェーズは、ユーザーが求めない限り対象から外す。全フェーズが済のときは、Issue 化せずにその旨を報告して終える。
済のフェーズを前提にするときは、その既存サブタスクを `owner/repo/N` で指す。
範囲の外で、まだ Issue の無いフェーズを前提にする行は、`blocked_by` に書かない。書かなかった行は、次の表と一緒にユーザーへ伝える。そのフェーズを範囲へ入れるかも確かめる。

抽出したフェーズ一覧を、次の列の表にしてユーザーに示す。Issue化する範囲（全フェーズ／一部のみ）と前提の合意を得てから Step 3 に進む。AskUserQuestion ではなく、地の文の表で示す。

| 列 | 内容 |
|---|---|
| Phase | tasks.md のフェーズ番号 |
| タイトル案 | Issue のタイトル |
| 済 | 既存サブタスクの Tasks に写っているフェーズに「済」と書く。未なら空 |
| 前提 | 着手を止める前提のフェーズと、種類（スタック可・スタック不可） |
| 一部だけの依存 | 一部のタスクだけが待つ依存 |

番号は書かない。通し番号は CLI が振る。

### Step 3: 各フェーズをIssueとして作成する

pecot-workflow の MCP サーバの resource `pecot-template://issue/task-implement` を読み、テンプレートのファイルをフェーズの数だけ作る。
ファイル名は `phase1.md`、`phase2.md` … とする。拡張子を除いた名前が、そのファイルのキーになる。

`owner`・`repo` には、**実装コードを置くリポ** を書く（w-ready と同じルール）。親 Epic が `aggregation_repo` にあっても、サブタスクは `aggregation_repo` に作らない（明示的な例外指示がある場合を除く）。詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

できた各ファイルを編集する。セクション構造（見出し）は変更せず、テンプレ冒頭コメントの `読者:`/`書き方:` に従って埋める。spec/plan の本文を転記しない（Artifacts のリンクで読者に届く）。
`title`・`owner`・`repo`・`parent_owner`・`parent_repo`・`parent_issue_number` を設定し、Step 2 の前提を `blocked_by` に写す。題の番号は、Epic の sub-issue の題で使っていない番号を、フェーズの順に振る。
`project_fields` の `pecot-lane` は、利用者が分類の値を言ったときだけ書く。言っていなければ空のままにし、尋ねもしない。

`blocked_by` の写し方は次のとおり。

| 前提の表 | `blocked_by` |
|---|---|
| `前提` のフェーズ | `issue`。そのフェーズのファイルのキー。Issue 化済みのフェーズは `owner/repo/N` |
| `種類` が「スタック可」 | `wait` を書かない |
| `種類` が「スタック不可」 | `wait: merge` と、`理由` のセルの文をそのまま写した `reason` |

前の版の w-breakdown が書いた tasks.md では、`種類` が「積める」「スタックできる」「マージを待つ」のことがある。「積める」と「スタックできる」は「スタック可」と、「マージを待つ」は「スタック不可」と同じに扱う。

`reason` は、表の `理由` と同じ文にする。言い換えない。縮めない。文が 2 つあっても、1 つにまとめない。
文は変えず、YAML の二重引用符の中に書くための置き換えだけをする。表の `\|` を `|` に戻してから、`\` を `\\`、`"` を `\"` にする。`reason` は 1 行で書き、改行を入れない。

前提の表の Phase 5 の行が次のとき、phase5 のファイルの `blocked_by` はその下のとおりになる。

```markdown
| 5 | 3 | スタック可 | スキルに、CI を直す種類を足す |
| 5 | 4 | スタック不可 | action は、既定のブランチのプラグインを入れる。main に入るまで、確認ができない |
```

```yaml
blocked_by:
  - issue: phase3
  - issue: phase4
    wait: merge
    reason: "action は、既定のブランチのプラグインを入れる。main に入るまで、確認ができない"
```

- 本文に前後関係を書かない。スタック不可の前提は、本文の末尾の `## Waits for merge` の節にも挙げる。書く行は `issue_check` が返す

tasks.md にある絵文字（`🎯 MVP` 等）は Issue ファイルに写さない。本文に絵文字があると投稿時の検証で落ち、一括投稿が途中で止まる。

**Artifacts セクションは必ず実パスへ置換する**（プレースホルダ `<owner/repo>:specs/<NNN-feature>/` を残したまま投稿しない）。Step 1 で確定した `SPECKIT_DIR` を貼る。

before / after の例を示す。

```diff
 ## Artifacts

-`<owner/repo>:specs/<NNN-feature>/`
+`acme-labs/aist-roadmap:specs/263-plan-mode-reminder/`
```

全フェーズ分のファイルを Phase の順に並べる。前提が後ろのフェーズを指すときは、前提にされるフェーズのファイルを先にする。

投稿の前に、pecot-workflow の MCP ツール `issue_check` に、全フェーズを 1 回で通し、番号・前提・置く列・進め方を確かめる。各フェーズの `key` は、ファイルの名前の幹にする。
結果の番号・前提・進め方を表にし、Step 2 の前提の表と並べてユーザーに示す。スタックできる並びも示す。前提の食い違いが無いかを見てもらう。
食い違いがあればファイルを直して、もう一度 `issue_check` で確かめる。合意を得てから投稿する。

投稿の手順は、[Issue とコメントを公式の MCP で書く](../w-help/references/issue-write.md) の「Issue を作る」のとおり。
フェーズの順に 1 件ずつ、公式の MCP の `issue_write`・`issue_dependency_write`・`projects_write` で書く。書いた Issue の番号で、後のフェーズの `{{issue:<key>}}` と `blocked_by` の key を置き換える。

書く途中で公式のツールが失敗したときは、次のとおりにする。

- 作った Issue は作られている。作り直さない。作り直すと Issue が重複する
- 失敗した書き込み（前提・ボードの欄など）だけを、理由とともに利用者に示し、残りのフェーズを続けるかを確かめる

### Step 4: 完了報告

作成した Phase と Issue 番号を表形式でユーザーに報告する。表には進め方（`issue_check` の `plan`）を足す。あわせて、スタックできる並びと、最初に着手できる Issue を示す。最初に着手できる Issue は、`Ready` に置かれた Issue とする。
警告があるときは、その文をそのままユーザーに伝える。実装開始は `/pecot-w:w-active` を使う旨を案内する。
