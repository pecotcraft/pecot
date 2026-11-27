# pecot の action

利用者のリポのワークフローが `uses:` で呼ぶ GitHub Actions の action と、そのワークフローの雛形です。どの action も AI を呼ばずに動きます。

## action の一覧

| action | 中身 | 呼ぶ雛形 |
|---|---|---|
| `board-sync` | ボードの列と札を、判定どおりに直す | `pecot-board-sync.yml` |
| `session-finish` | マージした PR の Issue を閉じ、待っていた Issue を動かす。ブランチは消さない | `pecot-board-sync.yml` |
| `review-finish` | 自動レビューが止まったときだけ、PR にその旨を書く | `pecot-review.yml` |
| `auto-gate` | 自動処理を進めるかと、その種類を決める | `pecot-auto.yml` |
| `auto-start` | 自動処理を始め、続けるための文脈をファイルに書く | `pecot-auto.yml` |
| `auto-finish` | 自動処理の結果のコメントを書き、待ちの Status を書いて起動ラベルを外す | `pecot-auto.yml` |
| `tracker-sync` | Dependabot の PR か security alert を、Tracker 1 件にそろえる | なし（このリポの `security-alerts.yml`・`dependabot-prs.yml`） |

inputs と outputs は、各 action の `action.yml` にあります。振る舞いの項目は `interface/authored.yaml` にあります。

## 導入

雛形は `templates/` にあります。pecot-workflow の MCP ツール `workflow_install` で置きます。

- `workflow_install` は、雛形の `pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>` を、タグの commit の SHA に直して書く
- 置いたあとの設定は `workflow_doctor` で確かめる
- 前に置いた雛形が npx で `@pecot/workflow-mcp` を呼んでいるときは、`workflow_doctor` が `outdated` を返す。`workflow_install` を `force: true` で呼んで置き直す

雛形ごとに要る secret と variable は、次のとおりです。

| 雛形 | secret と variable |
|---|---|
| `pecot-board-sync.yml` | variable `PECOT_BOARD_SYNC_APP_CLIENT_ID` と secret `PECOT_BOARD_SYNC_APP_PRIVATE_KEY`。または variable `PECOT_BOARD_SYNC_USE_PAT` と secret `PECOT_BOARD_SYNC_TOKEN` |
| `pecot-review.yml` | secret `CLAUDE_CODE_OAUTH_TOKEN` か、variable `PECOT_AGENT_ANTHROPIC_*` の 4 つ。自前の App を使うときは variable `PECOT_AGENT_APP_CLIENT_ID` と secret `PECOT_AGENT_APP_PRIVATE_KEY` |
| `pecot-handoff.yml` | `pecot-review.yml` と同じ |
| `pecot-auto.yml` | variable `PECOT_AGENT_APP_CLIENT_ID` と secret `PECOT_AGENT_APP_PRIVATE_KEY`。モデルの認証は `pecot-review.yml` と同じ |

詳しい置き方は、pecot-workflow の w-help の references にあります。雛形ごとに 1 つのファイルです。

## 版の上げ方

action のリリースのタグは `pecot-actions/v<版>` です。

- 置いた雛形は、`uses:` の行を SHA で固定し、末尾のコメントにタグを書く
- `.github/dependabot.yml` に `github-actions` の ecosystem があれば、Dependabot が SHA とコメントの版を一緒に上げる
- 雛形そのものの新しい版は、`workflow_install` を `force: true` で呼んで取り込む

## 開発

- 処理の本体は `src/commands/`、action ごとの起動は `src/<処理>.ts` にある。pecot-workflow と共有する部分は `libs/workflow-core` にある
- `dist/index.js` は rollup でまとめて commit する。`pnpm exec nx run actions:build` で作り直す。`lint-dist` が、commit した `dist` と作り直したものが同じかを確かめる
- 雛形の正は `templates/`。マーケットプレイスはプラグインのディレクトリだけを配るので、`plugins/pecot-workflow/cli/templates/workflow/` に写しを置く。直したら `pnpm --dir actions run sync-templates --write` で写す
- `interface/generated.json` は `action.yml` から作る。`pnpm --dir actions exec tsx scripts/export-interface.ts --write` で作り直す
- このリポのワークフローは、`uses: ./actions/<処理>` で呼ぶ
