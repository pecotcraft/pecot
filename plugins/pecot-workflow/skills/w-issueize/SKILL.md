---
name: w-issueize
description: |
  実装計画の各フェーズをIssueに一括登録します。
  Use when the user has a plan file (e.g. speckit's tasks.md) and wants each phase converted into GitHub Issues in bulk under a parent Epic, in Ready status.
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
- `TASKS_PATH`: 受け取った tasks.md の実パス（Step 4 で削除する対象）

```bash
pecot issue read owner/repo/EPIC_NUMBER
```

### Step 2: フェーズ構造を把握し、番号を決める

tasks.md を読み取り、Phase 1, Phase 2 ... の区切り・各フェーズのタイトル／目的／Tasks／Checkpoint／Independent Test を抽出する。同じディレクトリに plan.md や data-model.md などの補足ドキュメントがあれば文脈として合わせて読む。

フェーズの前提は、tasks.md の Phase Dependencies・User Story Dependencies・Parallel Opportunities の 3 つから決める。`[P]` はタスク単位の印なので使わない。並列の記述が無いときは、Phase Dependencies の表と各フェーズの本文から前提を決める。
前提にするのは、フェーズ全体の着手を止める依存だけ。一部のタスクだけが待つ依存は番号の計算に入れない。tasks.md のタスクに付いた依存の注記は、タスクの行ごと Tasks に写る。

親Epicの既存サブタスクから order 番号の続番を確認する（**番号決定のためだけに参照。Epic進捗の評価はしない**）。
続番の起点は、既存サブタスクの最大の `order` + 1（無ければ 1）。枝つきの既存番号（`18a` など）は段の数値で数える。今回 Issue 化しない前提（Issue 化済み・範囲外）は段の計算に入れない。

番号は次の手順で決める。

1. 段を決める。前提が無いフェーズは最初の段、それ以外は 1 + 前提の段の最大値
2. `order` = 続番の起点 + 段 − 1
3. 同じ段に 2 件以上あるときだけ、Phase 番号の順に `a`・`b`・`c`… を `parallel` に振る。1 件だけの段は `parallel` を空にする。同じ段が 27 件以上で `z` を超えるときは、ユーザーに相談する

抽出したフェーズ一覧と番号を、次の列の表にしてユーザーに示す。Issue化する範囲（全フェーズ／一部のみ）と番号の合意を得てから Step 3 に進む。AskUserQuestion ではなく、地の文の表で示す。

| 列 | 内容 |
|---|---|
| Phase | tasks.md のフェーズ番号 |
| 番号 | 例 `17a`（`order` と `parallel`） |
| タイトル案 | Issue のタイトル |
| 前提 | 着手を止める前提のフェーズ |
| 一部だけの依存 | 一部のタスクだけが待つ依存 |

番号が示すのは着手の条件で、前提にした Issue がすべて閉じたフェーズは着手できる。同じ段のフェーズは互いに依存しない。

### Step 3: 各フェーズをIssueとして作成する

フェーズ数だけテンプレートを生成する。

```bash
pecot issue create --prepare --template task-implement --suffix phase1 --repo <owner/repo>
pecot issue create --prepare --template task-implement --suffix phase2 --repo <owner/repo>
```

`--repo <owner/repo>` は、**実装コードを置くリポ** を指定する（w-ready と同じルール）。親 Epic が `aggregation_repo` にあっても、サブタスクは `aggregation_repo` に作らない（明示的な例外指示がある場合を除く）。詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

各ファイルを編集する。セクション構造（見出し）は変更せず、テンプレ冒頭コメントの `読者:`/`書き方:` に従って埋める。spec/plan の本文を転記しない（Artifacts のリンクで読者に届く）。
`title` / `parent_epic` を設定し、`order` に段、`parallel` に枝を Step 2 の表どおりに書く。`repository` には、`--repo` で指定した値が入っている。

tasks.md にある絵文字（`🎯 MVP` 等）は Issue ファイルに写さない。本文に絵文字があると投稿時の検証で落ち、一括投稿が途中で止まる。

**Artifacts セクションは必ず実パスへ置換する**（プレースホルダ `<owner/repo>:specs/<NNN-feature>/` を残したまま投稿しない）。Step 1 で確定した `SPECKIT_DIR` を貼る。

before / after の例を示す。

```diff
 ## Artifacts

-`<owner/repo>:specs/<NNN-feature>/`
+`acme-labs/aist-roadmap:specs/263-plan-mode-reminder/`
```

全フェーズ分のファイルを Step 2 の番号の順に並べ、1 回のコマンドで一括投稿する。
複数回に分けて実行しない。

```bash
pecot issue create <phase1のファイル> <phase2のファイル> ...
```

### Step 4: tasks.md を削除する

全フェーズのIssue投稿が成功したら、役目を終えた tasks.md を削除する。進捗管理はIssueに移譲したので不要。

```bash
rm <tasks.mdのパス>
```

### Step 5: 完了報告

作成した Phase と Issue 番号を表形式でユーザーに報告する。実装開始は `/pecot-w:w-active` を使う旨を案内する。
