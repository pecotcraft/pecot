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
| 起票・計画 | `/pecot-w:w-ready` | Epic 配下のサブタスクを 1 件作成し、前提に応じて Ready か Blocked に配置する |
| 起票・計画 | `/pecot-w:w-issueize` | 実装計画の各フェーズを Issue として一括登録する |
| 実装 | `/pecot-w:w-active` | Ready のタスクを選択し、ブランチ作成から実装計画の作成まで進める |
| 実装 | `/pecot-w:w-quick` | 小タスクの Issue 起票・ブランチ作成・実装計画の作成を一度に行う |
| PR・リリース | `/pecot-w:w-pr` | PR を作成する。タイトルと説明はコミット内容から生成する。CI を待ち、レビューの指摘の採否を自分で決めて直す。直さない指摘には理由を返信する。その後も画面でのマージを待ち受け、マージされたら後片付けまで済ませる |
| PR・リリース | `/pecot-w:w-review` | 自動レビューのワークフローが起こし、PR をレビューして指摘を PR に投稿する |
| PR・リリース | `/pecot-w:w-handoff` | 引き継ぎのワークフローが起こし、マージした PR の結果を Epic と後続の Issue にコメントで書く |
| PR・リリース | `/pecot-w:w-release` | CHANGELOG 更新・タグ作成・GitHub Release 公開までのリリースを実行する |
| 運用 | `/pecot-w:w-onboarding` | GitHub Projects ボードの作成とリポジトリ登録を行い、プロジェクトを新規セットアップする |
| 運用 | `/pecot-w:w-repo-add` | ボードにリポジトリを追加登録する |
| 運用 | `/pecot-w:w-worktree-add` / `/pecot-w:w-worktree-remove` | git worktree を作成・削除する |
| 運用 | `/pecot-w:w-help` | pecot CLI とスキルの使い方を調べる |

w-pr は、CI 待ちとマージの待ち受けが終わるたびに、自分を呼び直して続けます。
Claude Code の既定の権限では、呼び直しのときに、スキルを使うかの確認が出ます。
`Yes, and don't ask again for pecot-w:w-pr` を選ぶと、そのリポの `.claude/settings.local.json` に規則が入ります。
同じリポでは、worktree も含めて以後は出ません。
チームで共有するなら、`.claude/settings.json` の `permissions.allow` に `Skill(pecot-w:w-pr)` を書いてください。

## エージェント

スキルの実行中に、次のエージェントが起動されます。

| エージェント | 役割 |
|:-----------|:----|
| w-implementer | コード実装。コード変更とテスト作成 |
| w-plan-reviewer | 計画のレビュー。実装の計画を、技術・CUJ の 2 つの視点で見る |

## MCP サーバ

MCP サーバ `pecot-workflow` が、`pecot` CLI の 45 個のコマンドを MCP ツールとして公開します。
Issue・コメント・PR のテンプレートは、MCP の resource で読めます。URI は `pecot-template://<種類>/<名前>`（例: `pecot-template://comment/plan`）です。
ツール名は、`<対象> <動詞>` の空白を `_` に置き換えた形です（`issue create` は `issue_create`、`session start` は `session_start`）。
許可リストに書くツール名は、Claude Code では `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` です。
GitHub Copilot CLI では `pecot-workflow-<ツール名>` です。

Issue の前提（blocked by）と、前提の PR の上にスタックした PR（スタック PR）は、次の 4 つのツールで扱います。スキルの手順からも呼ばれます。

| ツール | 使う場面 |
|:------|:--------|
| `issue_block` / `issue_unblock` | 投稿した後の Issue の前提を付け外しする。前提の種類（スタックできる・マージを待つ）を変える |
| `pr_merge` | PR をマージする（スタックの中の PR は一番下だけ） |
| `pr_restack` | 親ブランチが変わったとき、スタックしたブランチを新しい位置へスタックし直す |

ボードの列（`Blocked`・`Ready` など）の読み方と、列を動かすものは、`/pecot-w:w-help` の「ボードステータス」にあります。
スタックして進める流れは、同じく「spec 駆動ワークフロー」にあります。

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
