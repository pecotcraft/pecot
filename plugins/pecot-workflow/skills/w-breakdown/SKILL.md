---
name: w-breakdown
description: |
  Epicをspeckitフローでサブタスクに分解します。
  Use when the user has an Epic and wants to break it down via the speckit workflow (specify → clarify → plan → tasks). Runs the speckit workflow (specify → clarify → plan → tasks) directly.
  Do NOT use for simple subtask creation (use w-ready), batch conversion (use w-issueize), or new Epics (use w-backlog).
when_to_use: "Epic をサブタスクに分解したい、speckit で計画を立てたい"
---

# Epic分解：speckit 工程の逐次実行

## pecot CLI ランチャー

pecot CLI は実行環境ごとにランチャーを変数化してから使う。

Claude Code:

```bash
PECOT=pecot
```

GitHub Copilot CLI は shell tool の PATH にプラグイン `bin/` が入らないため、最初からインストール済み wrapper を使う。

```bash
PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"
```

以降の pecot CLI コマンド例は必ず `$PECOT ...` として実行する。

Epic の内容を読み取り、main が speckit コマンド（specify → clarify → plan → tasks）を
逐次実行して分解する。speckit の成果物（ブランチ・`.specify/` 配下のファイル）は
**w-breakdown を実行したリポジトリ** に作成する。ただし `pecot project info` に表示
される **ロードマップリポ** が設定されている場合、そのロードマップリポでのみ実行を許可
する。ロードマップリポ設定があるのに別リポで起動された場合は中止し、ロードマップリポでの
再実行を案内する。

各工程の間で main は AskUserQuestion でユーザー承認を取り、承認を得てから次工程へ進む。

## 手順

### Step 1: ボードを確認する

```bash
$PECOT project info
```

### Step 2: 成果物作成先の決定（ロードマップリポチェック）

Step 1 の `pecot project info` 出力にある「ロードマップリポ: ...」行と CWD のリポを比べる。

CWD のリポを取得:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

`gh repo view` が失敗した場合（GitHub remote 未設定など）は、CWD のリポを自動判定できないとユーザーに伝え、現在地が想定リポか AskUserQuestion で確認する。

判定:

- **ロードマップリポ: 未設定** → CWD のリポで成果物を作る前提で進む
- **ロードマップリポ: <owner/repo>** かつ **CWD == その値** → そのまま進む
- **ロードマップリポ: <owner/repo>** かつ **CWD が異なる** → 中止し、次の文をユーザーに案内する

  > このプロジェクトではロードマップリポ `<owner/repo>` が設定されている。
  > w-breakdown はロードマップリポでのみ実行できる。`<owner/repo>` のワークツリーで再実行すること。

### Step 3: 対象Epicを特定

ユーザーの指示から対象Epicを特定する。Epic番号・タイトル指定なら直接使用、不明な場合は AskUserQuestion で Backlog 内の Epic を選択させる。

```bash
$PECOT issue read owner/repo/XXX
```

`owner/repo` は Epic Issue が置かれているリポ。speckit 成果物の作成先は Step 2 で確定済。

### Step 4: speckit 工程の準備

Epic の番号・タイトル・本文・背景を読み取り、specify への入力として main 自身が整理する。
工程ごとの責任者（spec / plan / tasks）は担当工程の概念として存在するが、本 single フローでは
main がそれぞれの責任者役を担って各コマンドを実行する。

整理する情報:

- Epic 番号（`#NNN`）
- 目的・スコープ
- 要件（Issue 本文から抽出）
- 背景情報（親 Epic や関連 Issue の内容）

### Step 5: specify 実行

main が `/speckit.specify` を実行する。Epic の内容から目的・スコープ・要件・背景情報・
Epic 番号を抽出し、`/speckit.specify` の引数として渡す。

実行後、AskUserQuestion でユーザー承認を取る（「次に進む」「修正を指示する」「やり直す」）。

### Step 6: 以降の工程 (clarify → plan → tasks) を逐次実行

main が各工程を順に実行する。各工程完了後に AskUserQuestion で以下の承認 3 択を提示し、
承認を得たら次工程へ進む。前工程の承認を得るまでは、次工程へ進まない。

| 選択 | 意味 |
|------|------|
| 次に進む | 次工程へ |
| 修正を指示する | main が修正内容を指定して再実行 |
| やり直す | 工程を最初からやり直す |

工程の順序: `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks`

analyze（`/speckit.analyze`）は読み取り専用工程のため任意。成果物の確認・検証が要るときに実行する。

tasks.md 完成後は `/pecot-w:w-issueize` で各フェーズを Issue として一括登録できる。
