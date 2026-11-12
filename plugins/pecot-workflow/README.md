<div align="center">

# pecot-workflow plugin

</div>

<!-- markdownlint-disable MD013 -->
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.141%2B-6B4FBB?style=flat-square&logo=anthropic&logoColor=white) ![GitHub Copilot CLI](https://img.shields.io/badge/Copilot_CLI-1.0.97%2B-24292F?style=flat-square&logo=githubcopilot&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-24.22.1%2B_%2F_26.12.1%2B-339933?style=flat-square&logo=node.js&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-1F1F1F?style=flat-square) ![GitHub Projects](https://img.shields.io/badge/GitHub_Projects_V2-181717?style=flat-square&logo=github&logoColor=white)
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

MCP サーバ `pecot-workflow` が、`pecot` CLI の 34 個のコマンドを MCP ツールとして公開します。
ツール名は、コマンドの空白と `-` を `_` に置き換えた形です（`issue create` は `issue_create`、`add-to-project` は `add_to_project`）。
許可リストに書くツール名は、Claude Code では `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` です。
GitHub Copilot CLI では `pecot-workflow-<ツール名>` です。

ブラウザ操作用に Playwright の MCP サーバ `pecot-workflow-playwright` と、ライブラリのドキュメントを引く `context7` も登録します。
ブラウザは、端末に入っている Google Chrome を使います。
Chrome が無い端末での入れ方は、[pecot-visual の README](../pecot-visual/README.md) を参照してください。

---

## 動作要件

- Claude Code 2.1.141 以上、または GitHub Copilot CLI 1.0.97 以上
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
