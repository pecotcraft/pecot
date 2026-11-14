<div align="center">

# pecot-workflow plugin

</div>

<!-- markdownlint-disable MD013 -->
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.141%2B-6B4FBB?style=flat-square&logo=anthropic&logoColor=white) ![GitHub Copilot CLI](https://img.shields.io/badge/Copilot_CLI-1.0.106%2B-24292F?style=flat-square&logo=githubcopilot&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-24.22.1%2B_%2F_26.12.1%2B-339933?style=flat-square&logo=node.js&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-1F1F1F?style=flat-square) ![GitHub Projects](https://img.shields.io/badge/GitHub_Projects_V2-181717?style=flat-square&logo=github&logoColor=white)
<!-- markdownlint-enable MD013 -->

GitHub Projects V2 と連携し、Issue 起票から実装・PR・リリースまでの開発ワークフローを提供します。
提供の形は、Claude Code / GitHub Copilot CLI のスキルです。
複数リポジトリを 1 つのボードで横断管理し、git worktree を使った並行開発に対応します。

---

## スキル

| 区分 | スキル | 内容 |
|:----|:------|:----|
| 起票・計画 | `/pecot-w:w-backlog` | Epic を作成し Backlog に配置する |
| 起票・計画 | `/pecot-w:w-breakdown` | Epic を speckit フロー（specify → clarify → plan → tasks）でサブタスクに分解する |
| 起票・計画 | `/pecot-w:w-ready` | Epic 配下のサブタスクを 1 件作成し Ready に配置する |
| 起票・計画 | `/pecot-w:w-issueize` | 実装計画の各フェーズを Issue として一括登録する |
| 実装 | `/pecot-w:w-active` | Ready のタスクを選択し、ブランチ作成から実装計画の作成まで進める |
| 実装 | `/pecot-w:w-quick` | 小タスクの Issue 起票・ブランチ作成・実装計画の作成を一度に行う |
| PR・リリース | `/pecot-w:w-pr` | PR を作成する。タイトルと説明はコミット内容から生成する |
| PR・リリース | `/pecot-w:w-revise` | 自分の PR をエージェントがレビューし、採用した指摘を修正する |
| PR・リリース | `/pecot-w:w-merge` | PR をマージし、ブランチ削除と後処理を行う |
| PR・リリース | `/pecot-w:w-release` | CHANGELOG 更新・タグ作成・GitHub Release 公開までのリリースを実行する |
| 運用 | `/pecot-w:w-onboarding` | GitHub Projects ボードの作成とリポジトリ登録を行い、プロジェクトを新規セットアップする |
| 運用 | `/pecot-w:w-repo-add` | ボードにリポジトリを追加登録する |
| 運用 | `/pecot-w:w-worktree-add` / `/pecot-w:w-worktree-remove` | git worktree を作成・削除する |
| 運用 | `/pecot-w:w-help` | pecot CLI とスキルの使い方を調べる |

## エージェント

スキルの実行中に、次のエージェントが起動されます。

| エージェント | 役割 |
|:-----------|:----|
| w-implementer | コード実装。コード変更とテスト作成 |
| w-tech-advisor | 技術調査。対象技術を解析し、計画・実装中の技術的な質問に回答する |
| w-e2e-planner | E2E テスト。CUJ の設計・妥当性レビューと、実際の CUJ 実行による検証 |

## MCP サーバ

MCP サーバ `pecot-workflow` が、`pecot` CLI の 36 個のコマンドを MCP ツールとして公開します。
ツール名は、`<対象> <動詞>` の空白を `_` に置き換えた形です（`issue create` は `issue_create`、`session start` は `session_start`）。
許可リストに書くツール名は、Claude Code では `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` です。
GitHub Copilot CLI では `pecot-workflow-<ツール名>` です。

ブラウザ操作用に Playwright の MCP サーバ `pecot-workflow-playwright` と、ライブラリのドキュメントを引く `context7` も登録します。
ブラウザは、端末に入っている Google Chrome を使います。
Chrome が無い端末での入れ方は、[pecot-visual の README](../pecot-visual/README.md) を参照してください。

Agent Plugins 1.0 に対応したクライアントが読み込むのは、スキルと MCP サーバです。
スキルの手順の一部は、クライアントの機能（質問の UI・プランモード）に頼ります。
hooks とエージェントは、Claude Code と GitHub Copilot CLI でだけ動きます。

プラグインを入れずにツールだけ使う場合は、npm のパッケージ `@pecot/workflow-mcp` の README を参照してください。

### MCP サーバにつながらないとき

Claude Code は、プラグインの stdio のサーバの起動の失敗を 15 分覚えます。
その間に始めたセッションは、15 分が過ぎても、そのセッションの中では試し直しません。
症状は、`Skipping connection (recent failure cached` で始まる文言です。

直し方は、次のどちらかです。

- `/mcp` でサーバを選んで Reconnect する
- 15 分たってから新しいセッションを始める

---

## コマンド名の移行

コマンドを、対象のグループ 9 個と、意味を決めた動詞で付け直しました。
名前は `<対象> <動詞>` の 2 語で、MCP のツール名は `<対象>_<動詞>` です。
次の 19 個は名前が変わり、古い名前は使えません。

| 古い名前 | 新しい名前 | 新しいツール名 |
|:---|:---|:---|
| `add-to-project` | `board add` | `board_add` |
| `update-issue-status` | `board move` | `board_move` |
| `project info` | `board show` | `board_show` |
| `create-branch` | `session start` | `session_start` |
| `pr cleanup` | `session finish` | `session_finish` |
| `session status` | `session show` | `session_show` |
| `delete-branch` | `branch delete` | `branch_delete` |
| `project set-repo` | `project link` | `project_link` |
| `project show-aggregation-repo` | `project get aggregation_repo` | `project_get` |
| `project set-aggregation-repo` | `project set aggregation_repo <値>` | `project_set` |
| `project unset-aggregation-repo` | `project unset aggregation_repo` | `project_unset` |
| `issue read` | `issue show` | `issue_show` |
| `pr read` | `pr show` | `pr_show` |
| `pr preflight` | `pr check` | `pr_check` |
| `release preflight` | `release check` | `release_check` |
| `dependabot sync` | `tracker sync dependabot` | `tracker_sync` |
| `security sync` | `tracker sync security` | `tracker_sync` |

残りのコマンドの名前は変わりません。ツールは 36 個になります。
設定のキー `aggregation_repo` と、入力名・フラグの `delete_branch`・`--delete-branch` も変わりません。

- 引数が増えるもの
  - `project get`・`project set`・`project unset` は、設定のキーを位置引数 `key` で取る。今のキーは `aggregation_repo` だけ。MCP のツールは `key: "aggregation_repo"` を渡す
  - `project set` は、値を 2 つ目の位置引数（MCP は `value`）で取る
  - `tracker sync` は、書き直す対象を位置引数 `source`（`dependabot` か `security`）で取る
- 許可の設定
  - 古いツール名を書いた許可は、使われなくなる。確認のダイアログが出るだけで、失敗はしない
  - Claude Code では、`mcp__plugin_pecot-w_pecot-workflow__<ツール名>` の `<ツール名>` を新しい名前にする
  - GitHub Copilot CLI では、`pecot-workflow-<ツール名>` の `<ツール名>` を新しい名前にする
  - `dependabot_sync` と `security_sync` を別々に許していたときも、許可は `tracker_sync` の 1 つになる
- スクリプト
  - `pecot` を呼ぶ自分のスクリプトは、表のとおり古い名前を新しい名前に書き換える
  - 古い名前を打つと、実行せずに新しい名前を案内して終了コード 2 で止まる（例: `'pr cleanup' was renamed to 'session finish'.`）
- スキル・hook・雛形は、同じ版で新しい名前に変わる。直すものは無い

## 動作要件

- Claude Code 2.1.141 以上、または GitHub Copilot CLI 1.0.106 以上
- [gh CLI](https://cli.github.com/) — `gh auth refresh -s project` で `project` スコープを追加してください
- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上 — `pecot` の実行に使う。初回の実行時に、依存の導入とビルドを行う（pnpm・corepack・npx のいずれかが要る）

インストール手順は[リポジトリルートの README](../../README.md) を参照してください。

---

## 設定

| 環境変数 | 内容 |
|:--------|:----|
| `XDG_DATA_HOME` | Bash から実行する `pecot` の実行用の環境を `$XDG_DATA_HOME/pecot/pecot-workflow` に作ります（`XDG_DATA_HOME` が未設定か絶対パスでなければ `~/.local/share/pecot/pecot-workflow`）。hook からの実行ではクライアントのデータ置き場を使います。プラグインをアンインストールしてもこの場所は残るので、不要になったら手で消してください |

---

## ライセンス

MIT License です。全文は [LICENSE](../../LICENSE) にあります。
