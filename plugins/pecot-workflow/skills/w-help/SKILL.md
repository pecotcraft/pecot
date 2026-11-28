---
name: w-help
description: |
  pecot-workflow の MCP ツールやスキルの使い方に関するヘルプ・ガイド。
  Use when the user asks "how do I..." questions about pecot workflow, MCP tools, board status, skills, or needs troubleshooting help.
  Do NOT use when a more specific pecot skill fits the task (w-pr, w-active, w-release, etc.).
when_to_use: "pecot の使い方が分からない、どのスキルを使えばよいか知りたい"
---

# pecot ヘルプ

pecot-workflow の MCP ツールとスキル群の使い方で迷ったとき、何から始めればよいか分からないときの案内所。

## やりたいことから探す

| やりたいこと | 使うスキル・ツール |
|-------------|-----------|
| 新規プロジェクトを始めたい | `/pecot-w:w-onboarding` |
| Epic（大きな計画）を作りたい | `/pecot-w:w-backlog` |
| 小さな作業をすぐ始めたい | `/pecot-w:w-quick` |
| Ready のタスクに着手したい | `/pecot-w:w-active` |
| PR を作りたい | `/pecot-w:w-pr` |
| PR のレビュー指摘に対応したい | `/pecot-w:w-pr` |
| PR をマージしたい | GitHub の画面でマージする。`/pecot-w:w-pr` が待ち受けて後片付けまで済ませる |
| develop → main にリリースしたい | `/pecot-w:w-release` |
| Epic をサブタスクに分解したい | `/pecot-w:w-breakdown` |
| 実装計画ファイルから Issue を一括登録したい | `/pecot-w:w-issueize` |
| Epic 配下に次のサブタスクを 1 件作りたい | `/pecot-w:w-ready` |
| Issue の前提（blocked by）を付け外ししたい・種類を変えたい | MCP ツール `issue_dependency_check` の後に、公式の MCP の `issue_dependency_write`。[GitHub に公式の MCP と github-ops で書く](references/github-write.md) |
| Issue に付けられる機能（ボードのフィールド・Issue fields など）と取りうる値を知りたい | [Issue の機能を名前で指定する](references/issue-attributes.md) |
| Issue の機能の値を名前で変えたい・外したい | MCP ツール `issue_check` の後に、公式の MCP の `issue_write`・`projects_write`。[Issue の機能を名前で指定する](references/issue-attributes.md) |
| 閉じた Issue を開き直したい | [Issue を開き直す](references/issue-reopen.md) |
| スタック PR を、親ブランチの新しい位置へスタックし直したい | `/pecot-w:w-pr`、または MCP ツール `pr_restack` |
| リポジトリをプロジェクトに追加したい | `/pecot-w:w-repo-add` |
| ワークツリーを作成したい | `/pecot-w:w-worktree-add` |
| ワークツリーを削除したい | `/pecot-w:w-worktree-remove` |

## トピック別リファレンス

| 知りたいこと | 参照先 |
|-------------|--------|
| MCP ツールの一覧 | [ツール一覧](references/commands.md) |
| GitHub に書く手順（Issue・コメント・列・ブランチ・PR・ボード・リリース。チェックと書く手の順） | [GitHub に公式の MCP と github-ops で書く](references/github-write.md) |
| 公式の MCP に手の無い操作を、`pecot-github-ops.yml` で行う | [github-ops で書く](references/github-ops.md) |
| Issue の機能（フィールド・担当者・マイルストーンなど）を名前で指定する | [Issue の機能を名前で指定する](references/issue-attributes.md) |
| ボードの列の読み方（`Blocked` と `Ready` の違い、列を動かすもの） | [ボードステータス](references/board-status.md) |
| 列を自動で直すワークフローを置きたい | [ボードを自動で直すワークフロー](references/board-sync-workflow.md) |
| PR を作ると自動でレビューを回すワークフローを置きたい・運用したい | [自動レビューのワークフロー](references/review-workflow.md) |
| マージした結果を Epic と後続の Issue に書くワークフローを置きたい・運用したい | [引き継ぎのワークフロー](references/handoff-workflow.md) |
| マージ方法の使い分け | [マージ戦略](references/merge-strategy.md) |
| スキル一覧・役割 | [スキル一覧](references/skills.md) |
| 認証・設定ファイル | [認証・設定ファイル](references/auth-config.md) |
| エラー・トラブル対応 | [トラブルシューティング](references/troubleshooting.md) |
| フラグシステムの仕組み | [フラグ一覧](references/flags.md) |
| speckit / spec 駆動ワークフロー、前提の PR の上にスタックして進める流れ（着手・PR・マージ・スタックし直し） | [spec 駆動ワークフロー](references/spec-driven-workflow.md) |
| Issue/PR 起票時のフロー基本ルール | [Issue/PR フロー基本ルール](references/issue-flow-rules.md) |
| スキルが起こすエージェントのモデルの決め方 | [エージェントのモデル](references/agent-models.md) |
| サブエージェントに委譲する条件と、起こす箇所ごとの理由 | [サブエージェントの使い方](references/subagent-usage.md) |
| 計画を書く前に、Issue と依頼の曖昧な点を利用者に聞く | [計画の前の clarify](references/plan-clarify.md) |
| 計画の CUJ を流す（実装の後、PR のレビューで直した後） | [CUJ の流し方](references/cuj-run.md) |

## よくある操作

pecot-workflow の機能は、MCP ツールだけで使う。ツールの一覧は [ツール一覧](references/commands.md)、入力の定義は MCP ツールの定義を読む。

## 公式の MCP をつなぐ

GitHub は、公式の MCP サーバ（github-mcp-server）のツールで読み書きする。スキルは、公式のツールをツール名（`issue_read`・`issue_write` など）で指す。

- 前提のツール（`issue_dependency_read`・`issue_dependency_write`）は、features の `issue_dependencies` で有効にする
- `issue_write` が書かずに入力の画面へ回さないよう、features に `mcp_apps_disable_form_deferral` も足す
- insiders のモードは使わない。`list_*` の結果が CSV のテキストになり、チェックのツールに渡せない
- 既定の toolset に、次の toolset を足す
  - `projects`: ボードを読み書きする（`projects_list`・`projects_write` など）
  - `actions`: github-ops を起動して結果を読む（`actions_run_trigger`・`get_job_logs` など）
  - `dependabot`・`code_security`・`secret_protection`: リリースの前に alert を読む（w-release だけが使う）
- リモートのサーバは、次の URL でつなぐ。手元のサーバは `--features` と `--toolsets` に、同じ値を渡す
  - `https://api.githubcopilot.com/mcp/?features=issue_dependencies,mcp_apps_disable_form_deferral`
  - toolset は、`X-MCP-Toolsets` の header で足すか、`https://api.githubcopilot.com/mcp/x/<toolset>` を別の接続として足す

公式のツールが無い、または読み取りだけでつながっているときは、書かずに止める。利用者に、上の形で書き込みのできるサーバをつなぐよう伝える。

リポの Dependabot の alert は、`list_dependabot_alerts` で読む。

## ボードの今の状態を読む

pecot-workflow の MCP ツール `board_show` に、公式の MCP で読んだものを `reads` で渡す。

1. ボードの owner と番号を、pecot-workflow の `project_list` で読む
2. `projects_list` で、ボードの欄（`list_project_fields`）を読む
3. `projects_list` で、カード（`list_project_items`）を全ページ読む。`fields` には、`pecot-status`・`Status`・`pecot-lane` の欄の ID を渡す
4. `Ready`・`Blocked` の Issue とその前提を `issue_read`（`get`）で読む
5. `Ready`・`Blocked` の Issue の前提を `issue_dependency_read`（`get_blocked_by`）で読む
