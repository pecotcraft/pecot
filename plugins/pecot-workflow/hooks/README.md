# pecot hooks

Claude Code / GitHub Copilot CLI 向けのフックシステム。

## 対応バージョン

最低対応版は、実機で動きを確かめた版にする。
「使う機能が入った版」の列は changelog の版で、それより前の版では動かない。

| クライアント | 最低対応版 | 確かめたこと | 使う機能が入った版 |
|---|---|---|---|
| Claude Code | 2.1.325 | スキルの frontmatter のフック（登録、`${CLAUDE_PLUGIN_ROOT}` の展開、`once: true` で 1 回で外れる） | frontmatter のフック（2.1.94）、UserPromptSubmit の `sessionTitle`（2.1.94）、SessionStart の `sessionTitle`（2.1.152）、別のスキルの同じ `once` のフックを消さない修正（2.1.304） |
| GitHub Copilot CLI | 1.0.112 | PreToolUse の deny と allow、SessionStart の `additionalContext` | PascalCase の定義で snake_case の入力が届く（1.0.21）、matcher の全体一致（1.0.36 / 1.0.62）、`permissionDecision` の `allow` で承認を省く（1.0.18）、`CLAUDE_PLUGIN_ROOT`（1.0.26） |

実機で最後に確かめた版は Claude Code 2.1.326 / Copilot CLI 1.0.112（[実機の記録](#実機の記録)）。
定義ファイルはクライアントごとに別。
Claude Code は `hooks/hooks.json`、Copilot CLI は `com.github.copilot/hooks/hooks.json` を読む。
Copilot CLI は Agent Plugins の vendor ディレクトリ（`com.github.copilot/`）の定義を読み、`hooks/hooks.json` は読まない。
全エントリに `timeout`（秒）を付けている。

## hooks-config.json

各フックの有効/無効を制御する設定ファイル。`.pecot/config/` に配置。

```bash
# サンプルからコピーして作成（.pecot の初期化で自動実行）
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
| `claude-bash-guards` | Bashガード統合エントリポイント（Claude Code / Copilot CLI 共通。Copilot も snake_case の `tool_input.command` を送るため入力形式の分岐は無い）。以下のコアガードを順次実行する。deny は `hookSpecificOutput.permissionDecision: "deny"` で返す（Copilot はトップレベルの `decision: "block"` を無視する） | PreToolUse (Bash) | `true` |
| `gh-pr-create-check` | `gh pr create` を検出しブロック。MCP ツールの `pr_create` の使用を強制する | コアガード | `true` |
| `gh-issue-create-check` | `gh issue create` を検出しブロック。MCP ツールの `issue_create`（自由形式の起票は `freeform: true`）の使用を強制する | コアガード | `true` |
| `gh-stack-check` | gh stack（`view` と `--help` の付いたものを除く）を検出しブロック。MCP ツールの `pr_create`・`pr_merge` の使用を強制する | コアガード | `true` |
| `git-no-verify-check` | 有効にしたときだけ、git のフックを飛ばす形を止める。対象は `--no-verify`、commit の `-n`（まとめ書きを含む。push の `-n` は `--dry-run` なので止めない）、引用符で囲んだそれらのオプション、`git -c core.hooksPath=`、`git config` で `core.hooksPath` を書く・消す形、前に置いた `SKIP=`・`HUSKY=0`。抜け道が多く守り切れないので、守りは CI に任せ、初期値は無効にしている | コアガード | `false` |
| `git-worktree-branch-check` | `wt*` ブランチへの直接commit/pushをブロック。featureブランチでの作業を強制する。判定するリポジトリは `git -C` / `cd` チェイン / ツールの cwd（Claude Code では hook 入力の `cwd`。Copilot CLI では未設定）の順に解決する | コアガード | `true` |
| `reviewer-clone-allow` | w-plan-reviewer の定型 clone（`.pecot/work/<Issue番号>/reviewer/<名前>` 宛の単一 `git clone`）を自動許可し、確認プロンプトを抑制する。全 deny ガード通過後のみ判定 | コアガード | `true` |

> コアガードは `claude-bash-guards` から呼び出される。個別に無効化可能。
> `pre-tool-use-bash.sh` は `merge-hook-outputs.sh` でガードの出力（deny / allow とその理由）と、`tmp-path-warner` のリマインダーを 1 つの JSON にまとめて返す。

#### deny と案内文

フックは承認（ask）を求めない。PR の作成・起票・マージと、Bash の `pecot` の起動は止めない。
deny は、両クライアントとも `hookSpecificOutput.permissionDecision: "deny"` と `permissionDecisionReason` で出す。
トップレベルの `decision` は使わない（Copilot CLI はトップレベルの `decision: "block"` を無視する）。
案内文は `lib/core/mcp-guidance.sh` の関数に置く。関数は次の 4 個。

- `mcp_guidance_gh_pr_create`・`mcp_guidance_gh_issue_create`・`mcp_guidance_gh_stack`
- `mcp_guidance_branch_delete`

### プランモード

ExitPlanMode の後のフック。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `exit-plan-remind` | ExitPlanMode 後に案内を返す（Claude Code のみ。Copilot CLI は frontmatter のフックを読まない）。承認した計画が、確認の前に Issue へ投稿した版から変わっていれば、投稿したファイルを直して MCP ツール `issue_comment` を呼び直すよう案内する。変わったかどうかによらず、同じターンで実装へ進むよう案内する。`--mode=active` は実装の引き継ぎ（`exit-plan-implementer-remind.md`）も足し、`--mode=quick` は足さない。`--mode` が無いか不正なら、stderr に出して終了コード 1 で終わる。計画の投稿はしない（確認の前にエージェントが投稿する） | w-active・w-quick の frontmatter の PostToolUse (ExitPlanMode) | `true` |

### セッション管理

セッション開始時と終了時の処理。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `session-start-common` | SessionStartのディスパッチャ（エントリ `session-start.sh` 1 本）。以下のサブスクリプトを順次呼び出す（`flock` があるときは多重実行防止ロック付き。標準の macOS には無いため、その環境ではロックを掛けずに実行する。Claude Code は matcher が startup・clear・resume・fork・compact の 5 つ、Copilot CLI は matcher なし（`new` / `resume`）。compact では `.gitignore` の補完だけが動く | SessionStart | `true` |
| `session-title` | Claude Code のセッション名を作業対象 Issue に合わせる。pecot-workflow が書く `.pecot/state/.pecot-session-title`（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字。作業中の Issue の番号は、ブランチ名の末尾の `/<番号>` から求める。題名ファイルが無ければ `#<番号>`）を `hookSpecificOutput.sessionTitle` で返す。SessionStart（`source` が startup / resume / fork のときだけ）と UserPromptSubmit（セッション途中の起票の次のプロンプト）の両方から同じ `lib/core/session-title.sh` を `merge-hook-outputs.sh` 経由で呼ぶ。`sessionTitle` は公式ドキュメント（hooks の「UserPromptSubmit decision control」「SessionStart decision control」）に記載があり、UserPromptSubmit は Claude Code 2.1.326 で適用も確認した。hook 入力に `transcript_path` が無いとき（Copilot CLI は SessionStart / UserPromptSubmit に送らない。1.0.103 で確認。Claude Code は `-p` でも対話でも送る。`session_title` は名前の無いセッションではキー自体が付かないため判別に使えない）、入力の `session_title` が題名と同じとき、ブランチ名の末尾が番号でないときは出さない。題名ファイルが別 Issue のもの・空のときは `#<番号>`。直前に出した `<session_id>:<題名>` を `.pecot/state/session-title-sent` に残し、同じ題名は再送しない（利用者の `/rename` は Issue が変わるまで上書きしない）。Copilot CLI の hook 出力に `sessionTitle` は無いため `com.github.copilot/hooks/hooks.json` には載せない | SessionStart（`session-start.sh` が `session-start-common` と別のスクリプトとして merge に渡す） / UserPromptSubmit（`user-prompt-submit-title.sh`） | `true` |
| `git-sync` | 有効にしたときだけ、未コミット変更がない場合にカレントブランチを `git pull` で最新化する。compact では pull しない。pull は 1 回だけ（`GIT_TERMINAL_PROMPT=0` と、`GIT_SSH_COMMAND` への `-o BatchMode=yes` の追加で認証の入力待ちをしない。既存の `GIT_SSH_COMMAND` は残す）で、失敗時は git の出力を stderr に出す | SessionStart サブスクリプト | `false` |

### ワークフロー

作業フロー制御。

| キー | 説明 | トリガー | デフォルト |
|------|------|----------|-----------|
| `tmp-path-warner` | Bashコマンド中の `/tmp/<X>` を検出し `.pecot/work/<タスクID>/<X>` への置き換えを `additionalContext` で促す（非ブロック）。`find`/`ls`/`du`/`df`/`stat`/`file`/`readlink`/`realpath` で始まる system 調査は抑制する | PreToolUse (Bash) | `true` |

## フック実行フロー

`hooks.json`（Claude Code）のトリガー定義からlib呼び出しまでの対応。
`post-tool-use-exit-plan-mode.sh` は、w-active・w-quick の frontmatter の PostToolUse（ExitPlanMode）から呼ばれる。
引数は `--mode=active|quick` で、`hooks.json` には登録しない。
括弧内の注記（`(Claude Code)` / `（deny 系 → reviewer-clone-allow）` 等）は、1段深い呼び出しの参考記載。
エントリスクリプトからの直接呼び出しではない。
`com.github.copilot/hooks/hooks.json`（Copilot CLI）は同じエントリを指す。
ただし、`user-prompt-submit-title.sh` の配線を持たない。
SessionStart は matcher なし。
Skill の matcher は `Skill|skill`。
各エントリの `timeout`（秒）は SessionStart 120、PreToolUse 10 になる。
UserPromptSubmit は 10。
pecot-visual の PostToolUse（Write / Edit）は 80 で、中の lint の打ち切り 10 + 30 + 30 秒より長くする。

```
settings.json トリガー          → シェルスクリプト                    → lib ディスパッチ
─────────────────────────────────────────────────────────────────────────────────────────
PreToolUse (Skill)              → pre-tool-use-skill.sh             → pecot-dir-init-detect
PreToolUse (Bash)               → pre-tool-use-bash.sh              → claude-bash-guards → コアガード群
                                                                       （deny 系 → reviewer-clone-allow）,
                                                                       tmp-path-warner

SessionStart (startup|clear|resume|fork|compact) → session-start.sh      → session-title (Claude Code のみ。common と別に merge へ渡す),
                                                                       session-start-common → git-sync

UserPromptSubmit                → user-prompt-submit.sh             → pecot-dir-init-detect
UserPromptSubmit                → user-prompt-submit-title.sh       → session-title（Claude Code のみ）
```

### Bash の hook 入力と解決回数

- 入力の JSON は、エントリが `lib/core/project-root.sh` を source した時点で、`lib/core/hook-input.sh` が 1 回の jq で読む。
  読んだ値は、`PECOT_HOOK_*` に export する。
  名前は `EVENT` / `TOOL_NAME` / `COMMAND` / `CWD` / `SESSION_ID` / `TRANSCRIPT_PATH`。
  残りは `PLAN_PATH` / `SKILL_NAME` / `SOURCE` / `SESSION_TITLE`。
  Bash の PreToolUse のサブスクリプトは、stdin の JSON を読み直さない。
  対象は、`claude-bash-guards` / `tmp-path-warner` ほか。
  環境変数 1 個が 128KiB を超えると以降の execve が失敗するため、tool の出力などの大きな値は export しない。
  コマンドが 60,000 バイトを超えるときは `PECOT_HOOK_COMMAND` を export しない。
  このとき Bash のガードはコマンドを空として扱い、ガードを通さずに素通しする。
- `hooks-config.json` はプロセス内の最初の `pecot_hook_enabled` 呼び出しで 1 回の jq で読んでキャッシュする。
- リポジトリの解決（`git rev-parse --show-toplevel`）は、Pre の Bash で 1 回だけ。

### 計画の Issue 投稿

フックは計画を投稿しない。w-active / w-quick の手順で、エージェントが確認の前に投稿する。

## 推奨設定

フックをやめた通知とプラグインの更新は、クライアントの組み込みの設定で行う。

### プラグインの自動更新

pecot のマーケットプレイスは公式のものではないので、自動更新が初期値で無効になっている。

- Claude Code — `/plugin` の Marketplaces タブで `pecot` を選び、「Enable auto-update」を選ぶ。下の JSON を設定ファイルに書いてもよい。`.claude/settings.json` に書いたものは、フォルダを信頼するまで読まれない
- GitHub Copilot CLI — 下の JSON を `~/.copilot/settings.json` に書く。リポジトリの設定に書いたものは読まれない。全体の `autoUpdate`（初期値は `true`、CI では `false`）も有効にしておく

`source` は必須で、`autoUpdate` だけを書いたエントリは読まれない。

```json
{
  "extraKnownMarketplaces": {
    "pecot": {
      "source": { "source": "github", "repo": "pecotcraft/pecot" },
      "autoUpdate": true
    }
  }
}
```

### 通知（Claude Code）

| 目的 | 設定 |
|---|---|
| 作業の完了や確認の待ちを、どの端末でも音で知る | `~/.claude/settings.json` に `"preferredNotifChannel": "terminal_bell"`。初期値（`auto`）では、Ghostty・Kitty・iTerm2 は通知を出し、Apple Terminal は音の出るベルが切ってあるときだけ音の無いベルを送り、そのほかの端末では何もしない |
| Remote Control の接続中に、スマートフォンへ通知を受ける | `/config` で「Push when actions required」（`inputNeededNotifEnabled`）と「Push when Claude decides」（`agentPushNotifEnabled`）を有効にする |
| 作業中・入力待ち・完了を、端末のタブで見る | 設定は要らない。OSC 7501 に対応した端末で、tmux の外で動かすと出る（2.1.295 以降） |

w-active・w-quick は frontmatter にフックを持つ。
そのため Claude Code 2.1.325 以降では、`/loop` や定期のタスクから起動すると、確認で止まる。
止めずに起動させたいときは、`permissions.allow` に次の 4 つを足す。
`Skill(name)` は引数なしの起動に、`Skill(name *)` は引数つきの起動に当たる。

```json
{
  "permissions": {
    "allow": [
      "Skill(pecot-w:w-active)",
      "Skill(pecot-w:w-active *)",
      "Skill(pecot-w:w-quick)",
      "Skill(pecot-w:w-quick *)"
    ]
  }
}
```

### 通知（GitHub Copilot CLI）

`copilot config <キー> true` で `~/.copilot/settings.json` に書く。`config.json` に書いた利用者の設定は読まれない。

| 目的 | 設定 |
|---|---|
| ターンの終わりや確認の待ちを、音で知る | `beep`（初期値は `false`）。1.0.112 で、ターンの終わりに BEL が 1 回出ることを確かめた |
| OS の通知を受ける | `notifications`（初期値は `false`）。端末にフォーカスがあるあいだは出ない |
| 端末の通知を使う | `terminalNotifications`（初期値は `false`）。`notifications` が有効なときだけ働き、Ghostty・WezTerm で OSC 777 を使う。tmux の中では OS の通知に切り替わる |

## 状態の置き場

フックが読み書きする `.pecot/state/` のファイルは、消えても動作が変わらない。
消えたときは、作り直すか、セッション名をもう一度送るだけになる。
ファイルごとの書き手・読み手・消し手は、w-help スキルの [flags.md](../skills/w-help/references/flags.md) にある。

## 実機の記録

確認日 2026-11-17。Claude Code 2.1.326 / GitHub Copilot CLI 1.0.112。
この worktree の `plugins/pecot-workflow` を `--plugin-dir` で読み、検証用の Issue（#516。確認の後に閉じた）のブランチで動かした。
Claude Code は tmux の対話のセッションで、Copilot CLI は `-p --mode autopilot` と tmux の対話のセッションで確かめた。
発火は、Claude Code の `--debug-file` と Copilot CLI の `--log-level debug` のログで見た。

### 残ったフック

| クライアント / 版 | 操作 | 発火した hook | 結果 | 確認日 |
|---|---|---|---|---|
| Claude 2.1.326 | 起動 | SessionStart（`startup`）: `session-start.sh` | 初期値の git-sync は pull しない。文脈に何も足さない | 2026-11-17 |
| Claude 2.1.326 | `claude -c` で再開・`/clear` | SessionStart（`resume`・`clear`）: `session-start.sh` | 有効にした git-sync が pull を 1 回だけ行い、その結果が `hookSpecificOutput.additionalContext` で文脈に入る。トップレベルの `additionalContext`（Copilot CLI 向け）は無視される | 2026-11-17 |
| Claude 2.1.326 | `/compact` | SessionStart（`compact`）: `session-start.sh` | セッション名は変わらず、`.gitignore` の pecot の行は残る | 2026-11-17 |
| Claude 2.1.326 | プロンプト（ブランチ名の末尾が Issue の番号） | UserPromptSubmit: `user-prompt-submit-title.sh`・`user-prompt-submit.sh` | `hookSpecificOutput.sessionTitle` で、セッション名が `#516 <題名>`（40 文字）になる。同じ題名は送り直さない | 2026-11-17 |
| Claude 2.1.326 | Skill ツールで w-help | PreToolUse（Skill）: `pre-tool-use-skill.sh` | `.pecot` が初期化済みなので、何も出さない | 2026-11-17 |
| 両方 | `gh pr create --fill --draft` | PreToolUse（Bash）: `pre-tool-use-bash.sh` | `gh-pr-create-check` の deny。理由に MCP ツール `pr_create` の案内が入る | 2026-11-17 |
| 両方 | `gh issue create`・`gh stack submit` | 同上 | `gh-issue-create-check`・`gh-stack-check` の deny | 2026-11-17 |
| 両方 | `wt1` ブランチでの `git commit` | 同上 | `git-worktree-branch-check` の deny | 2026-11-17 |
| 両方 | 初期値のままの `git commit --no-verify` | 同上 | 止めずに実行される | 2026-11-17 |
| 両方 | `git-no-verify-check` を有効にした `git commit --no-verify` | 同上 | `git-no-verify-check` の deny | 2026-11-17 |
| 両方（対話のセッション） | `git clone --depth 1 <url> .pecot/work/<番号>/reviewer/<名前>`（pecot-sandbox の clone で確認。このリポは `Bash(git *)` を許すため） | 同上 | `reviewer-clone-allow` の allow で、承認の確認が出ずに実行される。`reviewer/` の外への clone では確認が出る | 2026-11-17 |
| 両方 | `cat /tmp/x-468` | 同上 | `tmp-path-warner` の案内が `additionalContext` でエージェントに届く | 2026-11-17 |
| Copilot 1.0.112 | 起動（`-p`） | SessionStart: `session-start.sh` | 有効にした git-sync の結果が、トップレベルの `additionalContext` でモデルに届く | 2026-11-17 |
| Copilot 1.0.112 | skill ツールで w-help | `pre-tool-use-skill.sh`（matcher `Skill\|skill`） | スキルは名前空間なしで起動できる。`.pecot` が初期化済みなので、何も出さない | 2026-11-17 |

`git checkout wt1 && git commit …` のように 1 行でつなぐと、`git-worktree-branch-check` は止めない。
フックが判定する時点では、まだ元のブランチにいるためだ。
この抜け道はガードでは追わない。`wt*` に commit しても、PR と CI を経なければ `main` に入らない。フックで止めるのは、pecot の流れを外れるふつうの操作だけにする。

### スキルの frontmatter のフック

| 確かめる点 | 結果 | 版 | 確認日 |
|---|---|---|---|
| プラグインのスキルの frontmatter のフックが登録されるか | 登録される（debug ログに `Registered 1 hooks from skill`） | Claude 2.1.326 | 2026-11-17 |
| `command` の `${CLAUDE_PLUGIN_ROOT}` が展開されるか | 展開される | Claude 2.1.326 | 2026-11-17 |
| `once: true` で PostToolUse（ExitPlanMode）のフックが外れるか | w-quick の計画の承認で、計画の更新の案内だけが 1 回出て外れる（`Removing one-shot hook`）。2 回目の承認では出ない | Claude 2.1.326 | 2026-11-17 |
| `\|` を含む matcher で `once: true` が外れるか | 外れない。`ExitPlanMode\|exit_plan_mode` の組は承認のたびに動く。そのため matcher は `ExitPlanMode` だけにしている | Claude 2.1.326 | 2026-11-17 |
| compact の後に登録し直されるか | されない（「Skills restored」と出るが、次の承認で動かない） | Claude 2.1.326 | 2026-11-17 |
| resume の後に登録し直されるか | されない。外れる前に終えたセッションでも、再開後の承認で動かない | Claude 2.1.326 | 2026-11-17 |
| SessionStart が compact で起動するか | 起動し、セッション名は返さない | Claude 2.1.326 | 2026-11-17 |
| Copilot CLI が frontmatter のフックを読むか | 読まない。エラーは出ず、計画の承認の後の案内は出ない | Copilot 1.0.112 | 2026-11-16 |
| Copilot CLI の `beep: true` がターンの終わりで鳴るか | 鳴る。ターンの終わりに BEL が 1 回出る（`false` では 0 回） | Copilot 1.0.112 | 2026-11-17 |
| speckit の `speckit.git.feature` が、今のブランチ名を受けて新しいブランチを作らないか | 作らない（`GIT_BRANCH_NAME` と `--allow-existing-branch`） | speckit の git 拡張 1.0.1 / Claude 2.1.325 | 2026-11-16 |

### 未確認の項目

- macOS 標準の awk と bash 3.2 での `git-no-verify-check` の判定
- 画面に出る deny の理由の見え方
- `/loop` や定期のタスクから起動したとき、`Skill(name *)` の許可で確認が出なくなること

### スキル・エージェント定義

確認日 2026-10-25。Claude Code 2.1.310 / GitHub Copilot CLI 1.0.103（Issue #1231）。frontmatter の項目ごとの扱い。

| 項目 | Claude Code | Copilot CLI |
|---|---|---|
| スキルの `argument-hint` | スラッシュコマンドの入力欄に引数ヒントが出る | 文字列なら読み込まれるがモデルには渡らない。引用符なしの `[x]` は YAML のリストになり、そのスキルが読み込まれない（`argument-hint must be a string`）。値は必ず二重引用符で囲む |
| スキルの `when_to_use` | スキル一覧で description の後ろに付く（合計 1,536 文字まで） | 警告なしで読み込まれるが、モデルには渡らない |
| エージェントの `disallowedTools` | 指定したツールがエージェントから消える | 制限として働かない（`Bash` を除外したエージェントで Bash が実行された）。1.0.112 では `unknown fields ignored` の警告が出る（2026-11-17・Issue #551） |

- Claude はサブエージェントから `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` をもともと外すため、これらの
  除外は効果が無い
- `Agent` を除外すると、`--agent` 起動の init の tools からは `Task` が消える。`Bash` を除外すると `Monitor` も消える
- Windows では PowerShell ツールが自動で有効になるため、シェルを使わせないエージェントでは `Bash` と合わせて
  `PowerShell` も除外する
- Copilot の custom agents は `disallowedTools` を持たず、許可型の `tools` でツールを絞る。
  Copilot 向けの写し（`com.github.copilot/agents/`）の `tools` には、Claude で禁じていないツールを Copilot の名前で書く（Issue #551）。
  Claude 向けの `agents/` は除外型のままにする。MCP ツール名の形がクライアントで違い、許可の書き忘れで作業が止まるため
- `tools` には MCP のサーバ名を前もって書く。そのため、利用者のリポの MCP サーバは、エージェントからは使えない
- `claude plugin validate --strict`（pre-commit の `plugin-validate`）は未知のキー、`argument-hint` の型、
  `disallowedTools` のツール名を確かめない。これらは `cli/tests/hooks/lib/agent-definitions.test.ts` が固定している
