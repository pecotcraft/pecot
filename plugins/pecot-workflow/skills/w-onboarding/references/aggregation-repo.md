# Epic 集約リポ設定の詳細

`/pecot-w:w-onboarding` Step 4 の補足。集約リポ (`aggregation_repo`) を設定すると `issue_create`（`type: "epic"`）の作成先が自動ルーティングされる。

## 4.0 現状確認

`project_get` を `key: "aggregation_repo"` で呼ぶ。

- 未設定なら Step 4.1 Q1 は通常 3 択。
- 既設定（`<owner/repo>` 表示）なら Q1 に「現状維持 `<現在値>`」を追加。以降で**上書き**する場合は `yes: true` を付与する。付けなくても上書きされ、`yes` は警告の末尾のヒントを消すだけである。
  例: `project_set` を `key: "aggregation_repo"`・`value: "<owner/repo>"`・`yes: true` で呼ぶ。

## 4.1 AskUserQuestion Q1: 方針選択

- header: "Epic集約リポ"
- question: "Epic の集約方針（`issue_create`（`type: "epic"`）の自動ルーティング先を 1 リポにするか）"
- options:
  - label: "使わない", description: "Epic は都度 `repo` で作成先を明示する。後から設定変更可能"
  - label: "既存リポを指定（推奨）", description: "登録済みリポ、または任意の owner/repo を集約リポとして宣言"
  - label: "新規リポを作成", description: "`<project>-roadmap` 等の専用リポを作成して集約に設定"
  - label: "現状維持 `<現在値>`", description: "既設定のまま変更しない（4.0 で設定済を検出した場合のみ表示）"

分岐:

- 「使わない」「現状維持」→ Step 5 へ（追加の AskUserQuestion なし）
- 「既存リポを指定」→ 4.2a
- 「新規リポを作成」→ 4.2b

## 4.2a 既存リポを指定

`board_show` の結果の `stdout` にある `Registered repositories` の節から候補を取得する。`board_show` を引数なしで呼ぶ。

AskUserQuestion Q2a で選択:

- header: "集約リポ"
- question: "集約リポにするリポジトリ"
- options:
  - 登録済みリポジトリを 1 件ずつ列挙（例: `<owner>/<repoA>`, `<owner>/<repoB>` …）
  - label: "別のリポジトリ（自由入力）", description: "登録済み以外の `owner/repo` を入力"

選択結果で設定する。`project_set` を `key: "aggregation_repo"`・`value: "<owner/repo>"` で呼ぶ。

4.0 で既設定を検出済なら `yes: true` を付与する。

→ 4.3 へ。

## 4.2b 新規リポを作成

まず `gh` 認証を確認する。未認証なら `gh auth login` を案内して本ステップを中断する。

```bash
gh auth status
```

未認証だった場合の案内例:

```text
gh CLI が未認証です。以下を実行してから再度 /pecot-w:w-onboarding を再開してください。

  gh auth login
```

AskUserQuestion で以下 2 問を **1 回の呼び出しで** 質問する（`w-repo-add` Step 2.3 と同じパターン）:

質問 1: リポジトリ名

- header: "リポジトリ名"
- question: "集約リポの `owner/repo` を決めてください。"
- options:
  - label: "`<owner>/<project>-roadmap`（推奨）", description: "プロジェクト名を付けた専用ロードマップリポを作成"
  - label: "その他", description: "自由入力（例: `<owner>/roadmap`）"

質問 2: 可視性

- header: "可視性"
- question: "新規リポの可視性"
- options:
  - label: "`private`（推奨）", description: "プロジェクト関係者のみに限定"
  - label: "`public`", description: "誰でも閲覧可能"
  - label: "`internal`", description: "organization メンバーのみ閲覧可能（org 配下のみ）"

ヒアリング結果を使って、次の 3 つを **この順序で** 実行する。

1. `gh repo create <owner/repo> --<visibility> --add-readme`（Bash）
2. `project_link` を `repo: "<owner/repo>"`・`develop_branch: "main"` で呼ぶ
3. `project_set` を `key: "aggregation_repo"`・`value: "<owner/repo>"` で呼ぶ

- `--add-readme` は空リポ回避（README が無い空リポは clone できず、以降の Epic 作成も失敗しやすい）。
- 4.0 で既に集約リポが設定済みの場合、3 つ目の呼び出しに `yes: true` を足す。
- 新規リポは集約（ロードマップ）専用のため `release_branch` / `changelog_file` は指定しない。

## 4.3 確認

`project_get` を `key: "aggregation_repo"` で呼ぶ。

意図した `owner/repo` が返っていれば Step 5 へ進む。
