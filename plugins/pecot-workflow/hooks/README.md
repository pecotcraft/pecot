# pecot hooks

Claude Code / GitHub Copilot CLI 向けのフックシステム。

## 対応バージョン

| クライアント | 最低対応版 | 根拠 |
|---|---|---|
| Claude Code | 2.1.141 | `terminalSequence`（Stop / Notification の通知音）、Notification の matcher |
| GitHub Copilot CLI | 1.0.97 | PascalCase の定義で snake_case の入力が届くこと（1.0.21）、matcher の全体一致（1.0.36 / 1.0.62）、`permissionDecision` の `allow` で承認プロンプトを省くこと（1.0.18）、autopilot が `ask` を deny 扱いにすること（1.0.97） |

実機で確認した版は Claude Code 2.1.310 / Copilot CLI 1.0.103（[クライアント差分](#クライアント差分)）。
定義ファイルはクライアントごとに別。
Claude Code は `hooks/hooks.json`、Copilot CLI は `com.github.copilot/hooks/hooks.json` を読む。
Copilot CLI は、プラグインの `plugin.json` が指す定義だけを開く。
全エントリに `timeout`（秒）を付けている。

## hooks-config.json

各フックの有効/無効を制御する設定ファイル。`.pecot/config/` に配置。

```bash
# サンプルからコピーして作成（setup.sh が自動実行）
cp .pecot/config/hooks-config.json.sample .pecot/config/hooks-config.json
```

- `true`: 有効（フックが動作する）
- `false`: 無効（フックをスキップする）
- キーが存在しない場合: デフォルト値で動作

## hosts.json

GitHubホスト定義ファイル。`.pecot/config/` に配置。
セッション開始時にサンプルから初回コピーされる（既存ファイルは上書きしない）。

```bash
# サンプルからコピーして作成（セッション開始時に自動実行）
cp .pecot/config/hosts.json.sample .pecot/config/hosts.json
```

各ホストの設定:

| フィールド | 説明 |
|-----------|------|
| `env_var` | トークンを格納する環境変数名 |
| `token_url` | Personal Access Token の作成URL |
| `scopes` | 必要なトークンスコープ |
| `description` | ホストの説明 |

## .env

GitHub Personal Access Token を格納する環境変数ファイル。`.pecot/config/` に配置。
セッション開始時にサンプルから初回コピーされる（既存ファイルは上書きしない）。

```bash
# サンプルからコピーして作成（セッション開始時に自動実行）
cp .pecot/config/.env.sample .pecot/config/.env
```

hosts.json で定義された各ホストの `env_var` に対応するトークンを設定する。

## 設定キー一覧

### Bashガード

Bashコマンド実行前に危険な操作を検出・ブロックする。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `claude-bash-guards` | Bashガード統合エントリポイント（Claude Code / Copilot CLI 共通。Copilot も snake_case の `tool_input.command` を送るため入力形式の分岐は無い）。以下7つのコアガードを順次実行する。deny は `hookSpecificOutput.permissionDecision: "deny"` で返す（Copilot はトップレベルの `decision: "block"` を無視する） | PreToolUse (Bash) | `true` |
| `gh-pr-create-check` | `gh pr create` を検出しブロック。MCP ツールの `pr_create` の使用を強制する | コアガード | `true` |
| `gh-issue-create-check` | `gh issue create` を検出しブロック。MCP ツールの `issue_quick` / `issue_create` の使用を強制する | コアガード | `true` |
| `pecot-cli-deny` | Bash での pecot の起動（`pecot …`・`$PECOT …`・`…/bin/pecot …`。セグメントの先頭、環境変数の前置きのみ許す）を検出しブロック（deny）。理由に、対応する MCP ツール名（34 コマンド分）を入れる。ヒアドキュメントの本文、クオート内、行末の `\` で続く行の先頭（継続行は 1 つのコマンドとして連結する）は起動と扱わない。`env pecot …`・`bash -c "pecot …"`・`time pecot …` など先頭に別語が来る形は捕捉しない（検出抜け） | コアガード | `true` |
| `pecot-pr-create-ask` | MCP ツールの `pr_create`（実投稿）を検出しユーザー承認（ask）を要求。`prepare: true`・`dry_run: true` は素通し。`/pecot-w:w-pr`（短縮形 `/w-pr` を含む）起点フラグ（`pr-create-slash-pending`）存在時も素通し | MCP ハンドラ（pecot-post-ask） | `true` |
| `pecot-issue-create-ask` | MCP ツールの `issue_create` / `issue_quick`（実投稿）を検出しユーザー承認（ask）を要求。`issue_create` の `prepare: true` は素通し（`issue_quick` に `prepare` は無く、素通しにしない）。起票系スラッシュコマンド起点フラグ（`issue-create-slash-pending`）存在時も素通し | MCP ハンドラ（pecot-post-ask） | `true` |
| `gh-pr-merge-ask` | `gh pr merge` を検出しユーザー承認（ask）を要求。確認フラグの免除は持たない。`/pecot-w:w-merge`（短縮形 `/w-merge` を含む）起点フラグ（`merge-slash-pending`）存在時は素通し。案内文は `/pecot-w:w-merge`（マージは `gh pr merge`、片付けは MCP ツールの `pr_cleanup`） | コアガード（external-post-check） | `true` |
| `git-checkout-check` | `git checkout/switch` 実行前にuntrackedファイルの存在を警告する。判定するリポジトリは `git -C` / `cd` チェイン / ツールの cwd（Claude Code では hook 入力の `cwd`。Copilot CLI では未設定）の順に解決する | コアガード | `true` |
| `git-no-verify-check` | `git commit/push --no-verify` を検出しブロック。フックバイパスを禁止する | コアガード | `true` |
| `git-worktree-branch-check` | `wt*`/`develop-aist` ブランチへの直接commit/pushをブロック。featureブランチでの作業を強制する。判定するリポジトリは `git -C` / `cd` チェイン / ツールの cwd（Claude Code では hook 入力の `cwd`。Copilot CLI では未設定）の順に解決する | コアガード | `true` |
| `tech-advisor-clone-allow` | w-tech-advisor の定型 clone（`.pecot/work/<Issue番号>/tech-advisor/<名前>` 宛の単一 `git clone`）を自動許可し、確認プロンプトを抑制する。全 deny ガード通過後のみ判定 | コアガード | `true` |

> コアガードは `claude-bash-guards` から呼び出される。個別に無効化可能。
> `pre-tool-use-bash.sh` は `merge-hook-outputs.sh` でガードの出力（deny / ask / allow とその理由）と、`tmp-path-warner` / `pecot-issue-pending-reminder` のリマインダーを 1 つの JSON にまとめて返す。

#### 外部反映ガード（external-post-check）

MCP ツールの `pr_create`（実投稿）/ `issue_create` / `issue_quick`（実投稿）と、Bash の `gh pr merge` は、成果物を外部へ反映する操作。
そのため実行前にガードを挟み、いずれもユーザー承認（ask）を要求する。
MCP ツールの ask は `lib/mcp-handlers/pecot-post-ask.sh` が担う。`gh pr merge` の ask は `lib/core/external-post-check.sh` が担う。
案内文は `lib/core/mcp-guidance.sh` の関数に置く。関数は `mcp_guidance_post_ask_issue`・`mcp_guidance_post_ask_pr`・`mcp_guidance_pr_merge` の 3 つ。
Bash での pecot の起動は `pecot-cli-deny` が deny するので、ask の対象にしない。
マージは `gh pr merge`、片付けは MCP ツールの `pr_cleanup` で行う。
w-merge スキル起動はユーザーのマージ指示であり、マージ直前の再承認は求めない（#911）。
そのため `gh pr merge` は、`/pecot-w:w-merge` 起点のフラグ（`merge-slash-pending`）があれば素通しする。フラグが無ければ ask する。
`external-post-check` は `exit 11`（ask）を返し、`claude-bash-guards` が `permissionDecision: "ask"` に変換する。
`pecot-cli-deny` は `exit 1` を返し、`claude-bash-guards` が `permissionDecision: "deny"` に変換する。順は `git-no-verify-check` の後、`external-post-check` の前で、deny は ask と allow より先に返る。

| エージェント | ask（exit 11）の変換 | クライアントでの扱い（実機記録） |
|---|---|---|
| Claude Code | `permissionDecision: "ask"` | 対話モードは承認プロンプト。`-p` は拒否され、理由が tool_result に届く |
| GitHub Copilot CLI | `permissionDecision: "ask"`（Claude と同じ。deny には置き換えない） | 対話モードは承認ダイアログ。`-p` と autopilot はクライアントが deny 扱いにする（`Denied by preToolUse hook (unable to ask user for confirmation)`） |

deny は、両クライアントとも `hookSpecificOutput.permissionDecision: "deny"` と `permissionDecisionReason` で出す。
対象は PreToolUse の全出力。
含まれるのは、`claude-bash-guards` / `claude-adapter` / `pr-create-block` など。
PostToolUse の `decision: "block"` は変えない。

確認フラグによる素通しは、MCP ツールの `pr_create`（`prepare: true`・`dry_run: true`）と
`issue_create`（`prepare: true`）に適用する。`gh pr merge` はこれらのフラグを
免除しない。`pr_read` / `pr_cleanup` / `pr_preflight` /
`issue_read` / `issue_comment` はそもそも検出対象外。
`gh pr create` / `gh issue create` の deny（`gh-pr-create-check` / `gh-issue-create-check`）は
従来どおり温存する。

スラッシュコマンド起点の免除フラグは、`pr-create-slash-pending` / `issue-create-slash-pending` / `merge-slash-pending` の 3 つ。
このフラグは「投稿成功まで生存する一発券」で、ライフサイクルは次のとおり。
設置は `create-slash-flag.sh`（UserPromptSubmit）、消費は MCP ツールが実投稿成功時に削除する。
`merge-slash-pending` だけは、MCP ツール `pr_cleanup` の成功時に削除する。
残骸掃除は `create-slash-cleanup.sh`（SessionStart）が担う。
ターンを跨ぐ聞き返しフロー（起票内容の確認質問にユーザーが地の文で補足するケース）でも、フラグは生存する。

### プランモード

ExitPlanMode の後のフック。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `exit-plan-remind` | ExitPlanMode後に案内を返す。承認した計画が、確認の前に Issue へ投稿した版から変わっていれば、投稿したファイルを直して MCP ツール `issue_comment` を呼び直すよう案内する。クイックモードでなければ実装の引き継ぎ（`exit-plan-implementer-remind.md`）も足す。クイックモードフラグをクリアする。計画の投稿はしない（確認の前にエージェントが投稿する） | PostToolUse (ExitPlanMode) | `true` |

### セッション管理

セッション開始時と終了時の処理。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `session-start-common` | SessionStartのディスパッチャ（エントリ `session-start.sh` 1 本）。以下のサブスクリプトを順次呼び出す（`flock` があるときは多重実行防止ロック付き。標準の macOS には無いため、その環境ではロックを掛けずに実行する。Claude Code は matcher が startup・clear・resume・fork の 4 つ、Copilot CLI は matcher なし（`new` / `resume`） | SessionStart | `true` |
| `issue-pending-cleanup` | セッション開始時に残存する `issue-pending` フラグを削除する（Issue 未起票のまま中断した w-quick / w-ready の stale フラグを掃除する） | SessionStart サブスクリプト | `true` |
| `create-slash-cleanup` | セッション開始時に残存する `pr-create-slash-pending` / `issue-create-slash-pending` / `merge-slash-pending` フラグを削除する（前セッションの未消費フラグで実投稿の ask が免除されるのを防ぐ） | SessionStart サブスクリプト | `true` |
| `session-title` | Claude Code のセッション名を作業対象 Issue に合わせる。pecot-workflow が `.pecot-active` と同時に書く `.pecot/state/.pecot-session-title`（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字。旧版の CLI が書いた `.pecot-active` だけなら `#<番号>`）を `hookSpecificOutput.sessionTitle` で返す。SessionStart（`source` が startup / resume / fork のときだけ）と UserPromptSubmit（セッション途中の起票の次のプロンプト）の両方から同じ `lib/core/session-title.sh` を `merge-hook-outputs.sh` 経由で呼ぶ。`sessionTitle` は公式ドキュメント（hooks の「UserPromptSubmit decision control」「SessionStart decision control」）に記載があり、UserPromptSubmit は Claude Code 2.1.310 で適用も確認した。hook 入力に `transcript_path` が無いとき（Copilot CLI は SessionStart / UserPromptSubmit に送らない。1.0.103 で確認。Claude Code は `-p` でも対話でも送る。`session_title` は名前の無いセッションではキー自体が付かないため判別に使えない）、入力の `session_title` が題名と同じとき、`.pecot-active` の番号が数字でないときは出さない。題名ファイルが別 Issue のもの・空のときは `#<番号>`。直前に出した `<session_id>:<題名>` を `.pecot/state/session-title-sent` に残し、同じ題名は再送しない（利用者の `/rename` は Issue が変わるまで上書きしない）。Copilot CLI の hook 出力に `sessionTitle` は無いため `com.github.copilot/hooks/hooks.json` には載せない | SessionStart（`session-start.sh` が `session-start-common` と別のスクリプトとして merge に渡す） / UserPromptSubmit（`user-prompt-submit-title.sh`） | `true` |
| `session-project-dir` | `$CLAUDE_ENV_FILE` に `PECOT_SESSION_PROJECT_DIR`（セッションを開始した worktree のルート。Claude Code が渡した元の `CLAUDE_PROJECT_DIR` の git toplevel）を追記する。worktree の `.pecot/work` は base への symlink で、そこへ `cd` した後に Bash から呼ぶ `pecot` CLI が worktree の `.pecot/state` を読むための起点になる（この変数は CLI 用。hooks 側は Claude Code が渡す `CLAUDE_PROJECT_DIR` を直接起点に使う）。Copilot CLI には `CLAUDE_ENV_FILE` が無く、この設定は使えない | SessionStart サブスクリプト | `true` |
| `git-sync` | 未コミット変更がない場合にカレントブランチを `git pull` で最新化する。pull は 1 回だけ（`GIT_TERMINAL_PROMPT=0` と、`GIT_SSH_COMMAND` への `-o BatchMode=yes` の追加で認証の入力待ちをしない。既存の `GIT_SSH_COMMAND` は残す）で、失敗時は git の出力を stderr に出す | SessionStart サブスクリプト | `true` |
| `vscode-workspace-detector` | `code --status` からVSCodeのワークスペース情報を取得し表示する | SessionStart サブスクリプト | `true` |
| `gitignore-track-notice` | `.pecot/.gitignore` が未追跡なら `git add -f` で追跡を始める手順を、追跡中で定義の行が欠けていれば直す手順を案内する。index は変異させない | SessionStart サブスクリプト | `true` |
| `plugin-update-notice` | installed プラグインと marketplace clone の version 乖離を検知し、installed が古い場合に更新手順を案内する | SessionStart サブスクリプト | `true` |

### MCP・外部ツール連携

MCPツールやdraw.io等の外部ツールとの連携。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `pr-create-block` | MCP経由の `create_pull_request` 呼び出しをブロック（deny）。pecot-w:w-prスキル経由を強制する。Claude Code は `mcp__github*__create_pull_request`、Copilot CLI は `github-mcp-server-create_pull_request`（MCP のツール名は `<mcpServers のキー>-<ツール名>`） | PreToolUse (MCP) | `true` |
| `context7-allow` | context7 の読み取り2ツール（resolve-library-id / query-docs）を自動許可し、確認プロンプトを抑制する。Claude Code のみ（Copilot では context7 が OAuth を要して呼べず、allow が働くかは確かめられない。#789） | PreToolUse (mcp__.*) | `true` |
| `websearch-allow` | WebSearch（読み取り専用）を自動許可し、確認プロンプトを抑制する | PreToolUse (WebSearch) | `true` |

### 通知

ターミナル通知。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `terminal-bell` | Claude Code の Stop / Notification で `{"terminalSequence":"\u0007"}` を出し、ターミナルのタブフラッシュ・通知音をトリガーする。Notification は matcher（permission_prompt・idle_prompt・elicitation_dialog）に当たる通知だけ起動する。`pty-bell-sender` も有効なときだけ鳴らす（`pty-bell-sender: false` でベルを止めていた設定はそのまま有効） | Stop, Notification (Claude Code) | `true` |
| `pty-bell-sender` | Copilot CLI 用。プロセスツリーを遡って PTY にBEL文字を直接書き込み、ターミナルのタブフラッシュ・通知音をトリガーする（Copilot の hook 出力には `terminalSequence` が無い）。`stop-copilot.sh` からだけ呼ぶ | Stop (Copilot CLI) | `true` |
| `misplaced-pecot-notice` | リポジトリルート以外に生成された `.pecot/` ディレクトリを find 走査で検知し、`systemMessage` で正規の置き場（ルートの `.pecot/work/<Issue番号>/`）への移動・削除を案内する | Stop | `true` |

### ワークフロー

作業フロー制御。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `workflow-compliance-injector` | 先頭行が `/pecot-w:w-`（名前空間なしの短縮形 `/w-` を含む）で始まるプロンプトに禁止事項・手順厳守を強制する指示を注入する | UserPromptSubmit | `true` |
| `pecot-skill-compliance` | Skillツール経由の `pecot-w` / `pecot-w:*` スキル起動前に、PR作成・マージの独断禁止と手順厳守を `additionalContext` で注入する。Copilot CLI はスキル名が名前空間なし（`w-help`）で届くため、自プラグインの `skills/<名前>/SKILL.md` が実在する名前も `pecot-w:<名前>` として扱う | PreToolUse (Skill) | `true` |
| `pecot-skill-reminder` | pecotスキル起動直後にIssue追跡の義務をコンテキストに注入する（名前空間なしのスキル名の扱いは `pecot-skill-compliance` と同じ） | PostToolUse (Skill) | `true` |
| `tmp-path-warner` | Bashコマンド中の `/tmp/<X>` を検出し `.pecot/work/<タスクID>/<X>` への置き換えを `additionalContext` で促す（非ブロック）。`find`/`ls`/`du`/`df`/`stat`/`file`/`readlink`/`realpath` で始まる system 調査は抑制する | PreToolUse (Bash) | `true` |
| `pecot-issue-pending-state` | 先頭行が `/pecot-w:w-quick` / `/pecot-w:w-ready`（名前空間なしの短縮形 `/w-quick` / `/w-ready` を含む）で始まるプロンプトを検出し `issue-pending` フラグを作成する。pecot 未使用リポでは作成しない | UserPromptSubmit | `true` |
| `pr-create-slash-flag` | プロンプトの先頭行が `/pecot-w:w-pr`（名前空間なしの短縮形 `/w-pr` を含む）のとき `pr-create-slash-pending` フラグを作成し、MCP ツール `pr_create`（実投稿）の ask を投稿成功（MCP ツールが消費）まで免除する。フラグはエージェント側からも作成可能であり、免除は利便性であって防御境界ではない。pecot 未使用リポでは作成しない（設置スクリプトは `create-slash-flag.sh` を issue 側と共用） | UserPromptSubmit | `true` |
| `issue-create-slash-flag` | プロンプトの先頭行が `/pecot-w:w-quick` `/pecot-w:w-ready` `/pecot-w:w-backlog` `/pecot-w:w-issueize`（名前空間なしの短縮形 `/w-quick` 等を含む）のとき `issue-create-slash-pending` フラグ（内容 = 起点コマンド名）を作成し、MCP ツール `issue_quick` / `issue_create`（実投稿）の ask を投稿成功（MCP ツールが消費）まで免除する。pecot 未使用リポでは作成しない（設置スクリプトは `create-slash-flag.sh` を pr 側と共用） | UserPromptSubmit | `true` |
| `merge-slash-flag` | プロンプトの先頭行が `/pecot-w:w-merge`（短縮形 `/w-merge` を含む）のとき `merge-slash-pending` フラグを作成し、`gh pr merge` の ask を免除する。削除は MCP ツール `pr_cleanup` の成功時で、`gh pr merge` の時点では消さない（マージ待ちのあとに cleanup を呼ぶため）。pecot 未使用リポでは作成しない（設置スクリプトは `create-slash-flag.sh` を共用） | UserPromptSubmit | `true` |
| `pecot-issue-pending-reminder` | `issue-pending` フラグ存在中の Edit/Write/MultiEdit/NotebookEdit/EnterPlanMode（`pre-tool-use.sh`）と Bash の `git checkout`/`git switch`（`pre-tool-use-bash.sh`）に `additionalContext` で起票リマインドを注入する（非ブロック）。`*/.pecot/tmp/output/*` 宛の編集は除外。Copilot の Read / Edit は `tool_input.path` で届く | PreToolUse | `true` |
| `commit-info-display` | `git commit` 成功後にコミットメッセージとdiff統計を表示する。成功の判定は `bash-post-match.sh`（Claude の `tool_response.stdout` / Copilot の `tool_result.text_result_for_llm`）が 1 回だけ行う | PostToolUse (Bash) | `true` |
| `auto-push` | `git commit` 成功後にWIPブランチへ自動pushし、IssueのDevelopment欄にリンクする。対象は、`.pecot-active` の Issue 番号で終わり、`origin` が同じ owner/repo のブランチだけ。push の後で `origin/wip/` の追跡 ref を消し、`remote.origin.fetch` に `^refs/heads/wip/*` を足す | PostToolUse (Bash) | **`false`** |
| `branch-guard` | featureブランチ判定ロジックの制御。`false` にすると全ブランチでauto-push等が動作する | ライブラリ | `true` |

### アダプター

エージェント固有のプロトコル変換。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `claude-adapter` | 汎用ガードアダプタ。stdin JSONからコマンドを抽出しコアスクリプトに渡し、ブロックを `hookSpecificOutput.permissionDecision: "deny"` に変換する | ライブラリ | `true` |

## フック実行フロー

`hooks.json`（Claude Code）のトリガー定義からlib呼び出しまでの対応。
括弧内の注記（`(Claude Code)` / `（deny 系 → tech-advisor-clone-allow）` 等）は、1段深い呼び出しの参考記載。
エントリスクリプトからの直接呼び出しではない。
`com.github.copilot/hooks/hooks.json`（Copilot CLI）は同じエントリを指す。
ただし、Notification イベントと WebSearch の配線を持たない。
SessionStart は matcher なし、Stop は `stop-copilot.sh` を指す。
Skill の matcher は `Skill|skill`、MCP の matcher は `mcp__.*|github-mcp-server-create_pull_request` 。
各エントリの `timeout`（秒）は SessionStart 120、PreToolUse 10、PostToolUse は Bash 30・ExitPlanMode 90・その他 10 になる。
UserPromptSubmit / Notification / Stop は 10。
pecot-visual の PostToolUse（Write / Edit）は 80 で、中の lint の打ち切り 10 + 30 + 30 秒より長くする。

```
settings.json トリガー          → シェルスクリプト                    → lib ディスパッチ
─────────────────────────────────────────────────────────────────────────────────────────
PreToolUse (Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode) → pre-tool-use.sh → pecot-issue-pending-reminder
PreToolUse (Skill)              → pre-tool-use-skill.sh             → pecot-dir-init-detect,
                                                                       pecot-skill-compliance
PreToolUse (Bash)               → pre-tool-use-bash.sh              → claude-bash-guards → コアガード群
                                                                       （deny 系 → tech-advisor-clone-allow）,
                                                                       tmp-path-warner,
                                                                       pecot-issue-pending-reminder
PreToolUse (mcp__.*)            → pre-tool-use-mcp.sh               → mcp-dispatcher
                                                                       → pr-create-block →
                                                                       pecot-post-ask →
                                                                       context7-allow (Claude Code)
PreToolUse (WebSearch)          → pre-tool-use-websearch.sh         → websearch-allow

PostToolUse (Skill)             → post-tool-use-skill.sh            → pecot-skill-reminder
PostToolUse (Bash)              → post-tool-use-bash.sh             → commit-info-display, auto-push
PostToolUse (ExitPlanMode)      → post-tool-use-exit-plan-mode.sh   → exit-plan-remind

SessionStart (startup|clear|resume|fork) → session-start.sh              → session-title (Claude Code のみ。common と別に merge へ渡す),
                                                                       session-start-common → issue-pending-cleanup,
                                                                       create-slash-cleanup,
                                                                       session-project-dir, git-sync,
                                                                       vscode-workspace-detector,
                                                                       gitignore-track-notice, plugin-update-notice

UserPromptSubmit                → user-prompt-submit.sh             → pecot-dir-init-detect,
                                                                       workflow-compliance-injector,
                                                                       pecot-issue-pending-state,
                                                                       create-slash-flag
UserPromptSubmit                → user-prompt-submit-title.sh       → session-title（Claude Code のみ）

Stop                            → stop.sh                           → terminal-bell, auto-push, misplaced-pecot-notice
Stop                            → stop-copilot.sh                   → pty-bell-sender, auto-push, misplaced-pecot-notice
Notification (permission_prompt|idle_prompt|elicitation_dialog) → notification.sh → terminal-bell
```

### Bash の hook 入力と解決回数

- 入力の JSON は、エントリが `lib/core/project-root.sh` を source した時点で、`lib/core/hook-input.sh` が 1 回の jq で読む。
  読んだ値は、`PECOT_HOOK_*` に export する。
  名前は `EVENT` / `TOOL_NAME` / `COMMAND` / `CWD` / `SESSION_ID` / `TRANSCRIPT_PATH`。
  残りは `FILE_PATH` / `PLAN_PATH` / `SKILL_NAME`。
  Bash の PreToolUse のサブスクリプトは、stdin の JSON を読み直さない。
  対象は、`claude-bash-guards` / `tmp-path-warner` / `pecot-issue-pending-reminder` ほか。
  環境変数 1 個が 128KiB を超えると以降の execve が失敗するため、tool の出力などの大きな値は export しない。
  コマンドが 60,000 バイトを超えるときは `PECOT_HOOK_COMMAND` を export しない。
  このとき Bash のガードは内容を確かめられないので、ask を返す（`--no-verify` を含んでいても deny ではなく ask）。
- `hooks-config.json` はプロセス内の最初の `pecot_hook_enabled` 呼び出しで 1 回の jq で読んでキャッシュする。
- リポジトリの解決（`git rev-parse --show-toplevel`）は、Pre の Bash で 1 回だけ。PostToolUse(Bash) は
  `bash-post-match.sh` が成功した `git commit` だけを判定し、一致したときだけ解決する
  （commit は Pre / Post 各 1 回。それ以外の Bash の Post は解決しない）。`issue_create` / `issue_quick` の
  Post は解決しない（`issue-pending` は MCP ツールが起票成功時に消す）。

### 計画の Issue 投稿

フックは計画を投稿しない。w-active / w-quick の手順で、エージェントが確認の前に投稿する。

## クライアント差分

確認日 2026-10-25。Claude Code 2.1.310 / GitHub Copilot CLI 1.0.103（Issue #1229）。両クライアントの
実セッション（`-p` と Copilot の autopilot）で採った、変更前の記録・変更点・変更後の記録。

### 変更前の記録

| クライアント / 版 | 操作 | 発火した hook | 入力形式 | 応答 | 確認日 |
|---|---|---|---|---|---|
| Claude 2.1.310 | 起動 / 再開 | SessionStart: `session-start-new.sh`（再開は `-resume.sh`）1 回 + pecot-v 1 回 | snake_case、`source` = startup / resume | git-sync の Markdown が stdout | 2026-10-25 |
| Copilot 1.0.103 | 起動 / 再開 | SessionStart: pecot-w の 3 本（new / clear / resume）が全部起動 + pecot-v 1 回。matcher は使われない | snake_case、`source` = new / resume | 3 本とも git-sync し、同じ出力が 3 回。pull は 3 回（到達不能で 6 回） | 2026-10-25 |
| Copilot 1.0.103 | SessionStart / UserPromptSubmit（probe プラグイン、`-p`） | — | SessionStart は `cwd, hook_event_name, initial_prompt, session_id, source, timestamp`、UserPromptSubmit は `cwd, hook_event_name, prompt, session_id, timestamp`。`transcript_path` と `session_title` は無い | `session-title` はこれで Copilot を判別して無出力（`com.github.copilot/hooks/hooks.json` には載せない） | 2026-10-26 |
| Claude 2.1.310 | Bash `ls` | Pre: `pre-tool-use.sh`、`pre-tool-use-bash.sh` / Post: `post-tool-use-bash.sh` | `tool_name: "Bash"`、`tool_input.command`、Post は `tool_response.stdout` | 無出力。`--show-toplevel` が 3 回 | 2026-10-25 |
| Copilot 1.0.103 | Bash `ls` | 同上 | `bash` → `Bash`、Post は `tool_result.text_result_for_llm`（末尾に `<shellId: N completed with exit code 0>`）、`transcript_path` なし | 無出力 | 2026-10-25 |
| Claude 2.1.310 | Read | Pre: `pre-tool-use.sh` だけ | `tool_input.file_path` | 無出力 | 2026-10-25 |
| Copilot 1.0.103 | Read | 同上（matcher は守られる） | `view` → `Read`、`tool_input.path` | 無出力 | 2026-10-25 |
| Claude 2.1.310 | Write / Edit | Pre: `pre-tool-use.sh` / Post: pecot-v `post-tool-use-write.sh` / `-edit.sh` | `tool_input.file_path` | 無出力 | 2026-10-25 |
| Copilot 1.0.103 | 新規作成 / Edit | Pre: `pre-tool-use.sh` / Post: pecot-v `post-tool-use-edit.sh`（`write.sh` は起動しない） | `edit` / `apply_patch` → `Edit`。`tool_input.{path,old_str,new_str}`、`apply_patch` は `tool_input` が文字列 | 無出力 | 2026-10-25 |
| Claude 2.1.310 | Skill `pecot-w:w-help` | Pre: pecot-w / pecot-v の `pre-tool-use-skill.sh` / Post: `post-tool-use-skill.sh` | `tool_name: "Skill"`、`tool_input.skill` は接頭辞付き | `additionalContext` | 2026-10-25 |
| Copilot 1.0.103 | スキル w-help | `pre-tool-use-skill.sh` / `post-tool-use-skill.sh` は起動しない（matcher `Skill` が `skill` に当たらない） | `tool_name: "skill"`（小文字）、`tool_input.skill` は名前空間なし（同名が複数あるときだけ `<プラグイン名>:<名前>`） | 無出力 | 2026-10-25 |
| Claude 2.1.310 | MCP `mcp__plugin_*__*` | Pre: `pre-tool-use-mcp.sh` | `tool_name: "mcp__plugin_pecot-v_playwright__browser_tabs"` | 無出力 | 2026-10-25 |
| Copilot 1.0.103 | MCP | `pre-tool-use-mcp.sh` は起動しない（`mcp__.*` に当たらない） | `tool_name: "<mcpServers のキー>-<ツール名>"`（例 `playwright-browser_tabs`、組み込み GitHub MCP は `github-mcp-server-create_pull_request`） | 無出力 | 2026-10-25 |
| Claude 2.1.310 | WebSearch | Pre: `pre-tool-use-websearch.sh` | `tool_name: "WebSearch"` | `permissionDecision: "allow"` → 実行 | 2026-10-25 |
| Claude 2.1.310 | `gh pr merge 999999` | Pre: `pre-tool-use-bash.sh`（claude 段が応答） | snake_case | `permissionDecision: "ask"` → `-p` では拒否 | 2026-10-25 |
| Copilot 1.0.103 | `gh pr merge 999999` | 同上 | snake_case | `ask` → `-p` と autopilot ではクライアントが deny 扱い（`Denied ... (unable to ask user for confirmation)`）、実行なし | 2026-10-25 |
| Claude 2.1.310 | `git commit --no-verify` | Pre: `pre-tool-use-bash.sh` | snake_case | トップレベル `{"decision":"block"}` → 拒否 | 2026-10-25 |
| Copilot 1.0.103 | `git commit --no-verify` | 同上 | snake_case | トップレベル `{"decision":"block"}` を**無視して実行された**（`hookSpecificOutput.permissionDecision: "deny"` と、トップレベルの `permissionDecision: "deny"` は有効） | 2026-10-25 |
| Claude 2.1.310 | `git commit -m` | Post: `post-tool-use-bash.sh` | `tool_response.stdout` | `note: commit complete`と auto-push（bare に wip を push） | 2026-10-25 |
| Copilot 1.0.103 | `git commit -m` | 同上 | `tool_result.text_result_for_llm` | **無出力**、push なし（commit を検出しない） | 2026-10-25 |
| 両方 | `cat /tmp/x-1229` | Pre: `pre-tool-use.sh`（tmp-path-warner） | snake_case | `additionalContext` の `/tmp` リマインダー | 2026-10-25 |
| 両方 | UserPromptSubmit / Stop | `user-prompt-submit.sh` / `stop.sh` が各 1 回 | Claude は `transcript_path` あり。Copilot は Stop にだけ `transcript_path`（events.jsonl） | — | 2026-10-25 |

### この変更で変わる点

- Copilot の入力は、PascalCase の定義では全イベント snake_case で届く。
  そのため、camelCase（`toolName` / `toolArgs`）向けの処理を削除した。
  削除したのは、`copilot-bash-guards` / `copilot-adapter` / `copilot-pr-create-block` / dispatcher の二段目。
- deny を `hookSpecificOutput.permissionDecision` に揃えた。Copilot の `--no-verify` が実行されていた欠陥が直る
- ask は deny に置き換えない（Copilot の `-p` / autopilot は自前で deny、対話は確認ダイアログ）
- Copilot の commit は `tool_result.text_result_for_llm` からも検出する。コミット情報と auto-push が動く
- SessionStart は `session-start.sh` 1 本（Claude `startup|clear|resume|fork`、Copilot は matcher なし）。Copilot の
  git-sync が 3 回から 1 回になる。git-sync の pull は失敗時も 1 回だけ
- Bash の Pre は 1 エントリにまとめ、Edit 系のエントリ（`pre-tool-use.sh`）は matcher で絞る。Read で
  `pre-tool-use*.sh` は起動しない
- Copilot の Skill / MCP は `Skill|skill`、`mcp__.*|github-mcp-server-create_pull_request` の matcher で判定する。
  スキル名は名前空間なしでも、自プラグインの `skills/<名前>/SKILL.md` が実在すれば自プラグインのスキルとして扱う
- Copilot は SessionStart / PostToolUse で、トップレベルの `additionalContext` だけをモデルに渡す。
  `hookSpecificOutput.additionalContext` と素のテキストは届かない。PreToolUse の `hookSpecificOutput` は届く。
  `merge-hook-outputs.sh` がこの 2 イベントでトップレベルにも同じ内容を出し、SessionStart も merge 経由の JSON にした。
  Claude はトップレベルを読まないので、二重に入らない
- 通知音: Claude は `terminalSequence`、Copilot は `stop-copilot.sh`（PTY ベル）。Claude の Notification は
  `permission_prompt|idle_prompt|elicitation_dialog` だけ起動する

### 変更後の記録

| クライアント / 版 | 操作 | 発火した hook | 入力形式 | 応答 | 確認日 |
|---|---|---|---|---|---|
| Claude 2.1.310 | 起動 / 再開 | SessionStart: `session-start.sh` 1 回 + pecot-v 1 回。compact では起動しない。fork は matcher に含む（#1244）が、fork での発火は未確認。pecot-visual の SessionStart の matcher は `startup\|clear\|resume` で fork を含まないため、fork では pecot-v は起動しない（未確認） | `source` = startup / resume（compact は matcher で除外） | JSON の `additionalContext` で git-sync の結果が文脈に 1 回入る | 2026-10-25 |
| Copilot 1.0.103 | 起動 / 再開 | SessionStart: `session-start.sh` 1 回 + pecot-v 1 回 | `source` = new / resume | トップレベルの `additionalContext` で git-sync の結果がモデルに届く。pull は 1 回（到達不能でも 1 回） | 2026-10-25 |
| 両方 | Bash `ls` | Pre: `pre-tool-use-bash.sh` / Post: `post-tool-use-bash.sh` | 変更前と同じ | 無出力。`--show-toplevel` は Pre の 1 回だけ（Post は 0） | 2026-10-25 |
| Claude 2.1.310 | SessionStart（`.pecot-active` と `.pecot-session-title` がある worktree。`claude -p`） | `session-start.sh` → `session-title`（`session-start-common` とは別スクリプトで merge） | `source` = startup、`session_title` キー無し（名前の無いセッション）、`transcript_path` あり | `hookSpecificOutput.sessionTitle` が返り、transcript の `custom-title` が user プロンプトより前（SessionStart 分）に記録される。`session-title-sent` に `<session_id>:<題名>` が残る | 2026-10-26 |
| Claude 2.1.310 | UserPromptSubmit（`.pecot-active` と `.pecot-session-title` がある worktree） | `user-prompt-submit-title.sh` → `session-title` | `session_id` | `hookSpecificOutput.sessionTitle` で `~/.claude/sessions/<pid>.json` の `name` が `#1253 …`（`nameSource: hook`）に変わり、transcript に `custom-title` が記録され、Remote Control の一覧も同じ名前になる（対話セッションで確認、#1253）。`hooks.json` は起動時に読まれるため、起動中のセッションには新エントリが載らない | 2026-10-26 |
| 両方 | Read | pecot の PreToolUse は起動しない | 変更前と同じ | — | 2026-10-25 |
| 両方 | MCP（pecot-v / pecot-t、#1258 のキー改名後） | — | Claude は `mcp__plugin_pecot-v_pecot-visual__drawio_create`、Copilot は `pecot-visual-drawio_create` / `pecot-tools-aws_lambda_list_event_source_mappings`（キーがそのまま前置きになる） | ツールが呼ばれ、cli はそれぞれのクライアントのデータ置き場から起動する | 2026-10-26 |
| Copilot 1.0.103 | スキル w-help / v-drawio | pecot-w / pecot-v の Skill 系エントリが起動 | `tool_name: "skill"`、名前空間なし | pecot-w のスキル準拠の案内が届く。他のプラグインのスキルには応答しない | 2026-10-25 |
| 両方 | `gh pr merge 999999` | Pre: `pre-tool-use-bash.sh` | snake_case | `permissionDecision: "ask"` と理由。`-p` と Copilot の autopilot ではクライアントが拒否し、実行なし | 2026-10-25 |
| 両方 | `git commit --no-verify` | Pre: `pre-tool-use-bash.sh` | snake_case | `hookSpecificOutput.permissionDecision: "deny"` で拒否、理由が tool_result に届く | 2026-10-25 |
| 両方 | `git commit -m` / `git -C <path> commit` | Post: `post-tool-use-bash.sh` | Claude は `tool_response.stdout`、Copilot は `tool_result.text_result_for_llm` | `note: commit complete`が 1 回届き、auto-push が wip を push する。`--show-toplevel` は Pre / Post 各 1 回 | 2026-10-25 |
| 両方 | `cat /tmp/x-1229` | Pre: `pre-tool-use-bash.sh` | snake_case | `/tmp` のリマインダーが 1 回届く | 2026-10-25 |
| 両方 | SessionStart の timeout | 定義の timeout を 5 秒にし、hook に 45 秒の待ちを入れた写し | — | 約 5 秒で打ち切ってセッションが続く | 2026-10-25 |
| Claude 2.1.310 | ターンの終了 | Stop: `stop.sh` | — | `{"terminalSequence":"\u0007"}` を出す（`-p` では端末に出ない） | 2026-10-25 |
| Copilot 1.0.103 | ターンの終了 | Stop: `stop-copilot.sh` | — | PTY ベルを送る | 2026-10-25 |
| Copilot 1.0.103 | スキル w-quick | Post: `post-tool-use-skill.sh` | `tool_name: "skill"` | トップレベルの `additionalContext` で`note: pecot-workflow skill started`がモデルに届く | 2026-10-25 |
| Claude 2.1.310 | 70KB のコマンド + `git commit --no-verify` | Pre: `pre-tool-use-bash.sh` | snake_case | `permissionDecision: "ask"`（60,000 バイト超）→ `-p` では拒否、実行なし | 2026-10-25 |
| Claude 2.1.310 | 起票前の Write | Pre: `pre-tool-use.sh` | `tool_input.file_path` | 起票のリマインダーが届く | 2026-10-25 |
| Claude 2.1.310 | MCP の PR 作成 | Pre: `pre-tool-use-mcp.sh` | `tool_name: "mcp__github__create_pull_request"` | `permissionDecision: "deny"` で拒否、理由が届く | 2026-10-25 |
| Claude 2.1.310 | WebSearch | Pre: `pre-tool-use-websearch.sh` | `tool_name: "WebSearch"` | `permissionDecision: "allow"` → 実行 | 2026-10-25 |
| Claude 2.1.310 | スライドのページの Edit | Post: pecot-v `post-tool-use-edit.sh` | `tool_input.file_path` | lint の結果が文脈に 1 回入る | 2026-10-25 |

未確認の項目は次のとおり。
対話モードの ask の確認ダイアログ、画面に出る deny と git-sync の理由、ベルの音、Notification。
承認ダイアログでクリアを選んだときの実投稿（対話の画面でしか起こらないため）。
ExitPlanMode の初回ブロックと `/w-` のプロンプト（`-p` では使えないため）。
Copilot での 60,000 バイトを超えるコマンドと MCP の PR 作成（モデルが送らない・初期状態では出ないツールのため）。

### スキル・エージェント定義

確認日 2026-10-25。Claude Code 2.1.310 / GitHub Copilot CLI 1.0.103（Issue #1231）。frontmatter の項目ごとの扱い。

| 項目 | Claude Code | Copilot CLI |
|---|---|---|
| スキルの `argument-hint` | スラッシュコマンドの入力欄に引数ヒントが出る | 文字列なら読み込まれるがモデルには渡らない。引用符なしの `[x]` は YAML のリストになり、そのスキルが読み込まれない（`argument-hint must be a string`）。値は必ず二重引用符で囲む |
| スキルの `when_to_use` | スキル一覧で description の後ろに付く（合計 1,536 文字まで） | 警告なしで読み込まれるが、モデルには渡らない |
| エージェントの `disallowedTools` | 指定したツールがエージェントから消える | 警告なしで読み込まれるが、制限として働かない（v-slide-creator で Bash が実行された） |

- Claude はサブエージェントから `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` をもともと外すため、これらの
  除外は効果が無い。w-e2e-planner の `disallowedTools`（`AskUserQuestion` だけ）は Claude では実質の除外が無い
- `Agent` を除外すると、`--agent` 起動の init の tools からは `Task` が消える。`Bash` を除外すると `Monitor` も消える
- Windows では PowerShell ツールが自動で有効になるため、シェルを使わせない v-slide-creator は `Bash` と合わせて
  `PowerShell` も除外している
- Copilot でツールを制限するには、許可型の `tools` が要る（Copilot の custom agents は `disallowedTools` を持たない）。
  `tools` は許可したツール以外をすべて外すので、MCP ツール名の形がクライアントで違うことと、許可の書き忘れで作業が止まることに
  注意する。ここでは Issue #1231 の指定どおり除外型だけを使い、Copilot では制限が働かない
- `claude plugin validate --strict`（pre-commit の `plugin-validate`）は未知のキー、`argument-hint` の型、
  `disallowedTools` のツール名を確かめない。これらは `lib/tests/test_agent_definitions.py` が固定している
