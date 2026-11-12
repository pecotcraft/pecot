---
name: w-repo-add
description: |
  プロジェクトにリポジトリを追加登録します。
  Use when the user wants to register a new repository to the active GitHub Projects board so its Issues/PRs are tracked.
  Do NOT use for initial project setup from scratch (use w-onboarding).
when_to_use: "プロジェクトに別のリポジトリを追加したい、リポジトリを管理対象にしたい"
---

# リポジトリ追加

アクティブなプロジェクトにリポジトリを追加する。
プロジェクトは `/pecot-w:w-onboarding` 済みでアクティブになっていることが前提。

## 手順

### Step 1: アクティブプロジェクトの確認

`project_info` を引数なしで呼ぶ。

プロジェクト情報が表示された場合は Step 2 へ。
結果に `error: no active project` が出た場合は以下を案内して終了:

```text
アクティブなプロジェクトがありません。
先に /pecot-w:w-onboarding を実行してください。
```

### Step 2: リポジトリ情報の取得

**2.1 リポジトリ自動検出**

`git remote -v` の origin URL から `owner/repo` を取得する。

```bash
git remote -v
```

origin の fetch URL を解析し、`owner/repo` を特定する（例: `acme-labs/ai-engineer-starter-kit`）。

**2.2 AskUserQuestion: リポジトリ確認**

AskUserQuestion ツールで追加するリポジトリを確認:

- header: "リポジトリ"
- question: "追加するリポジトリを確認してください"
- options:
  - label: "`<検出したowner/repo>`（推奨）", description: "現在のリポジトリを追加"
  - label: "別のリポジトリ", description: "owner/repo形式で入力"

**2.3 AskUserQuestion: ブランチ・リリース設定**

AskUserQuestion ツールで以下を **1 回の呼び出しで** 質問する:

質問1: 開発ブランチ

- header: "開発ブランチ"
- question: "開発ブランチ（develop-branch）。PRのマージ先ブランチを指す"
- options:
  - label: "`main`（推奨）", description: "デフォルトブランチを使用"
  - label: "その他", description: "自由入力（例: `develop`, `develop-aist`）"

質問2: リリースブランチ

- header: "リリースブランチ"
- question: "リリースブランチ（release-branch）の設定。開発ブランチとは別にリリース用ブランチがある場合に設定する"
- options:
  - label: "設定しない（推奨）", description: "開発ブランチから直接リリースする場合"
  - label: "`main`", description: "mainブランチをリリースブランチとして使用"
  - label: "その他", description: "自由入力（例: `release`, `main`）"

**2.4 AskUserQuestion: CHANGELOG 構成（リリースブランチ設定時のみ）**

質問2でリリースブランチを設定した場合のみ質問する。

- header: "CHANGELOG 構成"
- question: "CHANGELOG の構成。`/pecot-w:w-release` でのリリース単位を決める"
- options:
  - label: "単一 CHANGELOG (`CHANGELOG.md`)（推奨）", description: "リポ root の `CHANGELOG.md` 1 本で管理"
  - label: "単一 CHANGELOG（別名）", description: "別ファイル名（例 `AIST-CHANGELOG.md`）を自由入力。"
  - label: "monorepo（複数 CHANGELOG）", description: "package 別の CHANGELOG。次の質問で AI が提案。タグは `<name>@v<ver>`"

**2.5 AskUserQuestion: package 一覧（monorepo の場合のみ）**

質問4で monorepo を選択した場合のみ、package ごとの `<name>:<changelog path>` を収集する。

1. リポ内を探索して CHANGELOG 候補を列挙（例: `plugins/*/CHANGELOG.md`、`packages/*/CHANGELOG.md` の glob 検索）
2. 各候補から妥当な `<name>` を推測（例: `plugins/pecot-workflow/CHANGELOG.md` → `pecot`）
3. AskUserQuestion で「この package 構成で登録する」と提案 → OK なら確定、変更要望なら自由入力を受け付け

### Step 3: リポジトリ追加

ヒアリング結果に応じて `project_set_repo` を呼ぶ。

**単一 CHANGELOG モード** (質問4 で「単一」を選択):

`project_set_repo` を次の入力で呼ぶ。

- `owner_repo: "<owner/repo>"`
- `develop_branch: "<branch>"`
- `release_branch: "<branch>"`
- `changelog_file: "<ファイル名>"`

**monorepo モード** (質問4 で「monorepo」を選択):

`project_set_repo` を次の入力で呼ぶ。

- `owner_repo: "<owner/repo>"`
- `develop_branch: "<branch>"`
- `release_branch: "<branch>"`
- `package: ["<name1>:<changelog path1>", "<name2>:<changelog path2>"]`

**リリースブランチ未設定**（CHANGELOG 質問なし）の場合は次のとおり。
`project_set_repo` を `owner_repo: "<owner/repo>"`・`develop_branch: "<branch>"` で呼ぶ。

| 入力 | 説明 |
|------|------|
| `owner_repo` | Step 2.2 で確認した owner/repo（必須） |
| `develop_branch` | 質問1で選択した開発ブランチ名 |
| `release_branch` | 質問2で選択したリリースブランチ名（設定時のみ） |
| `changelog_file` | 単一モード時のみ。デフォルト以外の場合のみ指定 |
| `package` | monorepo モード時のみ。`NAME:PATH` の配列で、package 数だけ渡す |

`changelog_file` と `package` は排他。`project_set_repo` を経由しないと設定ファイルが更新されず、ボード表示が正しく動作しない。

### Step 4: 動作確認

`project_info` を引数なしで呼ぶ。

`Registered repositories` セクションに追加したリポジトリが表示されれば成功。

### Step 5: 完了案内

```text
リポジトリ追加が完了しました。追加したリポジトリの Issue がボードに表示されます。

次のステップ:
  - 既存タスクに着手: /pecot-w:w-active
  - 小さなタスクを即起動: /pecot-w:w-quick
  - 並行作業セットを作成: /pecot-w:w-worktree-add
```
