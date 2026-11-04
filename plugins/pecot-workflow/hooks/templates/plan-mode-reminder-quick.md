<!-- mode: quick -->
# 【pecotクイックモード計画】

計画ドラフトは作成済みの前提です。ドラフト全体が plan テンプレの見出しと規則を満たすか確認し、計画を最終化して提示し、承認を得てください。

テンプレを取って埋めます。SKILL.md 冒頭の `$PECOT` で `$PECOT issue comment --prepare -t plan` を実行し、出力の見出しと冒頭コメントの規則に従って計画を書きます。
ExitPlanMode 後の Issue 投稿はこのテンプレで検証され、テンプレに無い見出しは止まります。

Claude Code 標準の 5 項目は次の見出しに対応させます。
Plan に検証の見出しを足しません。他に収まらないことは Notes に書きます。

- Context は Context
- 推奨方針は Approach
- 主要ファイルと再利用する既存関数は Files
- 検証は `## PECOT-Workflow` の E2E

クイックモードでは、サブエージェントを起動せず main が実装します。

計画の変更対象は active Issue のリポジトリ内に限定します。越境する変更は計画から外し、パッチ退避と当該リポへの起票提案に置き換えます（判定手順: skills/w-help/references/issue-flow-rules.md §6）。
