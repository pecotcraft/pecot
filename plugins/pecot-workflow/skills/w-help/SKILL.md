---
name: w-help
description: |
  pecot CLIやスキルの使い方に関するヘルプ・ガイド。
  Use when the user asks "how do I..." questions about pecot workflow, CLI commands, board status, skills, or needs troubleshooting help.
  Do NOT use when a more specific pecot skill fits the task (w-pr, w-active, w-merge, w-release, etc.).
when_to_use: "pecot の使い方が分からない、どのスキルを使えばよいか知りたい"
---

# pecot ヘルプ

pecot CLI とスキル群の使い方で迷ったとき、何から始めればよいか分からないときの案内所。

## やりたいことから探す

| やりたいこと | 使うスキル・ツール |
|-------------|-----------|
| 新規プロジェクトを始めたい | `/pecot-w:w-onboarding` |
| Epic（大きな計画）を作りたい | `/pecot-w:w-backlog` |
| 小さな作業をすぐ始めたい | `/pecot-w:w-quick` |
| Ready のタスクに着手したい | `/pecot-w:w-active` |
| PR を作りたい | `/pecot-w:w-pr` |
| PR のレビュー指摘に対応したい | `/pecot-w:w-pr` |
| PR をレビューして指摘を付けたい | `/pecot-w:w-review` |
| PR をマージしたい | `/pecot-w:w-merge` |
| develop → main にリリースしたい | `/pecot-w:w-release` |
| Epic をサブタスクに分解したい | `/pecot-w:w-breakdown` |
| 実装計画ファイルから Issue を一括登録したい | `/pecot-w:w-issueize` |
| Epic 配下に次のサブタスクを 1 件作りたい | `/pecot-w:w-ready` |
| Issue の前提（blocked by）を付け外ししたい・種類を変えたい | MCP ツール `issue_block` / `issue_unblock` |
| 積んだ PR を、下の段の新しい位置へ載せ直したい | `/pecot-w:w-pr`、または MCP ツール `pr_restack` |
| リポジトリをプロジェクトに追加したい | `/pecot-w:w-repo-add` |
| ワークツリーを作成したい | `/pecot-w:w-worktree-add` |
| ワークツリーを削除したい | `/pecot-w:w-worktree-remove` |

## トピック別リファレンス

| 知りたいこと | 参照先 |
|-------------|--------|
| CLI コマンド一覧（MCP ツールは、コマンドの空白と `-` を `_` に替えた名前） | [コマンド一覧](references/commands.md) |
| ボードの列の読み方（`Blocked` と `Ready` の違い、列を動かすもの） | [ボードステータス](references/board-status.md) |
| 列を自動で直すワークフローを置きたい | [ボードを自動で直すワークフロー](references/board-sync-workflow.md) |
| マージ方法の使い分け | [マージ戦略](references/merge-strategy.md) |
| スキル一覧・役割 | [スキル一覧](references/skills.md) |
| 認証・設定ファイル | [認証・設定ファイル](references/auth-config.md) |
| エラー・トラブル対応 | [トラブルシューティング](references/troubleshooting.md) |
| フラグシステムの仕組み | [フラグ一覧](references/flags.md) |
| speckit / spec 駆動ワークフロー、前提の PR の上に積んで進める流れ（着手・PR・マージ・載せ直し） | [spec 駆動ワークフロー](references/spec-driven-workflow.md) |
| Issue/PR 起票時のフロー基本ルール | [Issue/PR フロー基本ルール](references/issue-flow-rules.md) |
| スキルが起こすエージェントのモデルの決め方 | [エージェントのモデル](references/agent-models.md) |
| サブエージェントに委譲する条件と、起こす箇所ごとの理由 | [サブエージェントの使い方](references/subagent-usage.md) |
| 計画の CUJ を流す（実装の後、PR のレビューで直した後） | [CUJ の流し方](references/cuj-run.md) |

## よくある操作

利用者が端末か `!` で打つ CLI のヘルプは `--help` で確認できる。エージェントは Bash で打たず、MCP ツールを使う。入力の定義は MCP ツールの定義を読む。

```text
pecot --help             # コマンド一覧
pecot <command> --help   # サブコマンドの詳細
pecot --version          # バージョン表示
```

ボードの現在状態を確認したいときは、pecot-workflow の MCP ツール `board_show` を使う。
