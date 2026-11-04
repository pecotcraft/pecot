---
name: w-backlog
description: |
  Epicを作成しBacklogに配置します。
  Use only when the user explicitly invokes /pecot-w:w-backlog or explicitly asks to register an Epic in the Backlog. Do not trigger autonomously from vague phrases like "plan a feature", "big initiative", or "add to roadmap".
  Do NOT use for breakdown (use w-breakdown), single subtasks (use w-ready/w-quick), or batch Issue creation from a plan (use w-issueize).
when_to_use: "Epic を Backlog に登録して、と明示的に頼まれたとき"
argument-hint: "[Epic の内容]"
---

# Epic作成ワークフロー

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

ユーザー指示からEpicを作成し、Issue本文を直接充実させてBacklogに配置する。実装コード・ブランチ作成・プルリクエスト作成は行わない。実装は `/pecot-w:w-ready` でサブタスクを作成し、`/pecot-w:w-active` で行う。

## 手順

### Step 1: ボードを確認する

```bash
$PECOT project info
```

| ステータス | 意味 |
|-----------|------|
| Active | 別ワークツリーで作業中 |
| Ready | 未着手タスク |
| Pending | 後回し・保留中（Epic／タスク） |
| Backlog | Epic置き場 |

### Step 2: 既存Epicを確認

Backlog内に類似のEpicがないか確認する。

- 類似Epicがある場合は、統合や調整を提案する
- **重複を避けるための確認は必須**

### Step 3: 集約リポの事前確認

Epic の作成先を決定するため、`aggregation_repo` の設定状況をまず確認する。

```bash
$PECOT project show-aggregation-repo
```

- **設定済み**（`owner/repo` が返る）→ Step 4 へ進む
- **未設定**（`未設定` が返る）→ AskUserQuestion で分岐:
  - 「先に集約リポを設定する（推奨）」→ `/pecot-w:w-onboarding` を案内してこのスキルを中断
  - 「このまま個別リポに Epic を作る（分散運用）」→ Step 4 へ進む（作成時 `repository` 必須）

集約リポを後から追加すると、既存 Epic を移送する運用負荷が生じる。可能なら先に設定することを推奨する。

### Step 4: Epic Issueを作成

```bash
# 1. テンプレート準備
$PECOT issue create --prepare --template epic

# 2. 出力されたファイルを編集
#    - YAMLフロントマター設定
#    - Issue本文を記述（テンプレ冒頭コメントの 読者:/書き方: に従う）

# 3. 投稿
$PECOT issue create <ファイルパス>
```

CLI が出力したファイルのセクション構造を維持して本文を埋める。テンプレ冒頭コメントの `読者:`（Epic を分解する人）の判断に使われない情報は書かない。

**YAMLフロントマターの設定:**

`title`（必須）を設定する。`[Epic]` プレフィックスはCLIが自動付与するため不要。

**リポジトリの特定方法:**

- 集約リポ設定済（Step 3 で `owner/repo` が返った）→ `repository: ""` のまま。CLI が自動で集約リポに作成する
- 集約リポ未設定（Step 3 で「このまま個別リポに作る」を選んだ）→ `repository: <owner/repo>` を **必須** で指定する。未指定だと `pecot issue create` が exit 2 で失敗
- ユーザーが実装リポ名を言及しても安易に `--repo` で上書きせず、まず集約リポ行きで提案する。例外的に集約リポ以外へ作る時のみ `--repo <impl-repo>` で明示する（CLI は stderr 警告を出しつつ作成を許可）
- 詳細マトリクス: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

下書きの文章規則は、Claude Code で pecot-visual を入れた環境なら、下書きを Write / Edit した直後に確かめられる。
違反があると `[text-lint] Writing-rule violations in` で始まる通知が返る。指摘の行の文を書き直す。
下書きは書き込みで止まらず、投稿の CLI も文面を確かめない。投稿前に直す。何も返らないことは、違反が無いことを意味しない。
`[text-lint] Not checked` は、確認していないという通知を表す。
違反が多いと先頭 100 行だけが返る。直して保存し直すと、残りが返る。
関門（pre-commit と commit-msg）を入れたリポでは、commit する文書とコミットメッセージが止まる。
出力の形はリポで異なる。例は `<path>:<line>:<col> <ruleId> <message>` と、ファイル名の行に続く `行:列 error メッセージ 規則名` の 2 形がある。
どちらも、指摘された行の文を直す。
規則・除外は変えない。無効化コメントと `--no-verify` にも触れない。

### Step 5: 完了報告

ユーザーに以下を報告:

- 作成したEpic Issue番号・タイトル
- Epic概要（何を実現するか）
- 次のステップの案内: **このEpicからタスクを切り出すには `/pecot-w:w-ready` を使用**
