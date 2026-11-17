# pecot hooks

Claude Code / GitHub Copilot CLI 向けのフックシステム。

## 対応バージョン

| クライアント | 最低対応版 | 根拠 |
|---|---|---|
| Claude Code | 2.1.141 | PreToolUse の `hookSpecificOutput.permissionDecision`（deny / allow と理由）。根拠だった `terminalSequence` を撤廃したので、版は Phase 8（#468）で見直す |
| GitHub Copilot CLI | 1.0.97 | PascalCase の定義で snake_case の入力が届くこと（1.0.21）、matcher の全体一致（1.0.36 / 1.0.62）、`permissionDecision` の `allow` で承認プロンプトを省くこと（1.0.18）、autopilot が `ask` を deny 扱いにすること（1.0.97） |

セッション名の `sessionTitle` は、UserPromptSubmit が 2.1.94、SessionStart が 2.1.152 から読まれる。
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
| `claude-bash-guards` | Bashガード統合エントリポイント（Claude Code / Copilot CLI 共通。Copilot も snake_case の `tool_input.command` を送るため入力形式の分岐は無い）。以下のコアガードを順次実行する。deny は `hookSpecificOutput.permissionDecision: "deny"` で返す（Copilot はトップレベルの `decision: "block"` を無視する） | PreToolUse (Bash) | `true` |
| `gh-pr-create-check` | `gh pr create` を検出しブロック。MCP ツールの `pr_create` の使用を強制する | コアガード | `true` |
| `gh-issue-create-check` | `gh issue create` を検出しブロック。MCP ツールの `issue_create`（自由形式の起票は `freeform: true`）の使用を強制する | コアガード | `true` |
| `gh-stack-check` | gh stack（`view` と `--help` の付いたものを除く）を検出しブロック。MCP ツールの `pr_create`・`pr_merge` の使用を強制する | コアガード | `true` |
| `git-no-verify-check` | 有効にしたときだけ、git のフックを飛ばす形を止める。対象は `--no-verify`、commit の `-n`（まとめ書きを含む。push の `-n` は `--dry-run` なので止めない）、引用符で囲んだそれらのオプション、`git -c core.hooksPath=`、`git config` で `core.hooksPath` を書く・消す形、前に置いた `SKIP=`・`HUSKY=0`。抜け道が多く守り切れないので、守りは CI に任せ、初期値は無効にしている | コアガード | `false` |
| `git-worktree-branch-check` | `wt*` ブランチへの直接commit/pushをブロック。featureブランチでの作業を強制する。判定するリポジトリは `git -C` / `cd` チェイン / ツールの cwd（Claude Code では hook 入力の `cwd`。Copilot CLI では未設定）の順に解決する | コアガード | `true` |
| `tech-advisor-clone-allow` | w-tech-advisor の定型 clone（`.pecot/work/<Issue番号>/tech-advisor/<名前>` 宛の単一 `git clone`）を自動許可し、確認プロンプトを抑制する。w-reviewer の clone も同じパスに置くので、同じく許可される。全 deny ガード通過後のみ判定 | コアガード | `true` |

> コアガードは `claude-bash-guards` から呼び出される。個別に無効化可能。
> `pre-tool-use-bash.sh` は `merge-hook-outputs.sh` でガードの出力（deny / allow とその理由）と、`tmp-path-warner` のリマインダーを 1 つの JSON にまとめて返す。

#### deny と案内文

フックは承認（ask）を求めない。PR の作成・起票・マージと、Bash の `pecot` の起動は止めない。
deny は、両クライアントとも `hookSpecificOutput.permissionDecision: "deny"` と `permissionDecisionReason` で出す。
対象は PreToolUse の全出力。PostToolUse の `decision: "block"` は変えない。
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
| `session-title` | Claude Code のセッション名を作業対象 Issue に合わせる。pecot-workflow が書く `.pecot/state/.pecot-session-title`（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字。作業中の Issue の番号は、ブランチ名の末尾の `/<番号>` から求める。題名ファイルが無ければ `#<番号>`）を `hookSpecificOutput.sessionTitle` で返す。SessionStart（`source` が startup / resume / fork のときだけ）と UserPromptSubmit（セッション途中の起票の次のプロンプト）の両方から同じ `lib/core/session-title.sh` を `merge-hook-outputs.sh` 経由で呼ぶ。`sessionTitle` は公式ドキュメント（hooks の「UserPromptSubmit decision control」「SessionStart decision control」）に記載があり、UserPromptSubmit は Claude Code 2.1.310 で適用も確認した。hook 入力に `transcript_path` が無いとき（Copilot CLI は SessionStart / UserPromptSubmit に送らない。1.0.103 で確認。Claude Code は `-p` でも対話でも送る。`session_title` は名前の無いセッションではキー自体が付かないため判別に使えない）、入力の `session_title` が題名と同じとき、ブランチ名の末尾が番号でないときは出さない。題名ファイルが別 Issue のもの・空のときは `#<番号>`。直前に出した `<session_id>:<題名>` を `.pecot/state/session-title-sent` に残し、同じ題名は再送しない（利用者の `/rename` は Issue が変わるまで上書きしない）。Copilot CLI の hook 出力に `sessionTitle` は無いため `com.github.copilot/hooks/hooks.json` には載せない | SessionStart（`session-start.sh` が `session-start-common` と別のスクリプトとして merge に渡す） / UserPromptSubmit（`user-prompt-submit-title.sh`） | `true` |
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
括弧内の注記（`(Claude Code)` / `（deny 系 → tech-advisor-clone-allow）` 等）は、1段深い呼び出しの参考記載。
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
                                                                       （deny 系 → tech-advisor-clone-allow）,
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
| Claude 2.1.310 | WebSearch | Pre: `pre-tool-use-websearch.sh` | `tool_name: "WebSearch"` | `permissionDecision: "allow"` → 実行 | 2026-10-25 |
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
- SessionStart は `session-start.sh` 1 本（Claude `startup|clear|resume|fork`、Copilot は matcher なし）。Copilot の
  git-sync が 3 回から 1 回になる。git-sync の pull は失敗時も 1 回だけ
- Copilot の Skill は `Skill|skill` の matcher で判定する。
  スキル名は名前空間なしでも、自プラグインの `skills/<名前>/SKILL.md` が実在すれば自プラグインのスキルとして扱う
- Copilot は SessionStart / PostToolUse で、トップレベルの `additionalContext` だけをモデルに渡す。
  `hookSpecificOutput.additionalContext` と素のテキストは届かない。PreToolUse の `hookSpecificOutput` は届く。
  `merge-hook-outputs.sh` がこの 2 イベントでトップレベルにも同じ内容を出し、SessionStart も merge 経由の JSON にした。
  #466 で Copilot 向けの定義から PostToolUse が無くなり、トップレベルに出すのは SessionStart だけになった。
  Claude はトップレベルを読まないので、二重に入らない

### 変更後の記録

| クライアント / 版 | 操作 | 発火した hook | 入力形式 | 応答 | 確認日 |
|---|---|---|---|---|---|
| Claude 2.1.310 | 起動 / 再開 | SessionStart: `session-start.sh` 1 回 + pecot-v 1 回。compact では起動しない。fork は matcher に含む（#1244）が、fork での発火は未確認。pecot-visual の SessionStart の matcher は `startup\|clear\|resume` で fork を含まないため、fork では pecot-v は起動しない（未確認） | `source` = startup / resume（compact は matcher で除外） | JSON の `additionalContext` で git-sync の結果が文脈に 1 回入る | 2026-10-25 |
| Copilot 1.0.103 | 起動 / 再開 | SessionStart: `session-start.sh` 1 回 + pecot-v 1 回 | `source` = new / resume | トップレベルの `additionalContext` で git-sync の結果がモデルに届く。pull は 1 回（到達不能でも 1 回） | 2026-10-25 |
| Claude 2.1.310 | SessionStart（`.pecot-active` と `.pecot-session-title` がある worktree。`claude -p`） | `session-start.sh` → `session-title`（`session-start-common` とは別スクリプトで merge） | `source` = startup、`session_title` キー無し（名前の無いセッション）、`transcript_path` あり | `hookSpecificOutput.sessionTitle` が返り、transcript の `custom-title` が user プロンプトより前（SessionStart 分）に記録される。`session-title-sent` に `<session_id>:<題名>` が残る | 2026-10-26 |
| Claude 2.1.310 | UserPromptSubmit（`.pecot-active` と `.pecot-session-title` がある worktree） | `user-prompt-submit-title.sh` → `session-title` | `session_id` | `hookSpecificOutput.sessionTitle` で `~/.claude/sessions/<pid>.json` の `name` が `#1253 …`（`nameSource: hook`）に変わり、transcript に `custom-title` が記録され、Remote Control の一覧も同じ名前になる（対話セッションで確認、#1253）。`hooks.json` は起動時に読まれるため、起動中のセッションには新エントリが載らない | 2026-10-26 |
| 両方 | Read | pecot の PreToolUse は起動しない | 変更前と同じ | — | 2026-10-25 |
| 両方 | MCP（pecot-v / pecot-t、#1258 のキー改名後） | — | Claude は `mcp__plugin_pecot-v_pecot-visual__drawio_create`、Copilot は `pecot-visual-drawio_create` / `pecot-tools-aws_lambda_list_event_source_mappings`（キーがそのまま前置きになる） | ツールが呼ばれ、cli はそれぞれのクライアントのデータ置き場から起動する | 2026-10-26 |
| Copilot 1.0.110 | プランの承認（`-p --plan --mode autopilot`） | PostToolUse: `post-tool-use-exit-plan-mode.sh`（matcher `ExitPlanMode\|exit_plan_mode`） | `tool_name: "exit_plan_mode"`（Claude の `ExitPlanMode` に置き換わらず、そのまま届く）、`tool_result.result_type: "success"` | `hook.end` の `output.additionalContext` に、計画の打ち直しと実装の引き継ぎの案内が入る（#403） | 2026-11-13 |
| 両方 | `git commit --no-verify` | Pre: `pre-tool-use-bash.sh` | snake_case | `hookSpecificOutput.permissionDecision: "deny"` で拒否、理由が tool_result に届く | 2026-10-25 |
| 両方 | `cat /tmp/x-1229` | Pre: `pre-tool-use-bash.sh` | snake_case | `/tmp` のリマインダーが 1 回届く | 2026-10-25 |
| 両方 | SessionStart の timeout | 定義の timeout を 5 秒にし、hook に 45 秒の待ちを入れた写し | — | 約 5 秒で打ち切ってセッションが続く | 2026-10-25 |
| Claude 2.1.310 | スライドのページの Edit | Post: pecot-v `post-tool-use-edit.sh` | `tool_input.file_path` | lint の結果が文脈に 1 回入る | 2026-10-25 |

未確認の項目は次のとおり。
画面に出る deny と git-sync の理由。
ExitPlanMode の初回ブロックと `/w-` のプロンプト（`-p` では使えないため）。

### スキル・エージェント定義

確認日 2026-10-25。Claude Code 2.1.310 / GitHub Copilot CLI 1.0.103（Issue #1231）。frontmatter の項目ごとの扱い。

| 項目 | Claude Code | Copilot CLI |
|---|---|---|
| スキルの `argument-hint` | スラッシュコマンドの入力欄に引数ヒントが出る | 文字列なら読み込まれるがモデルには渡らない。引用符なしの `[x]` は YAML のリストになり、そのスキルが読み込まれない（`argument-hint must be a string`）。値は必ず二重引用符で囲む |
| スキルの `when_to_use` | スキル一覧で description の後ろに付く（合計 1,536 文字まで） | 警告なしで読み込まれるが、モデルには渡らない |
| エージェントの `disallowedTools` | 指定したツールがエージェントから消える | 警告なしで読み込まれるが、制限として働かない（`Bash` を除外したエージェントで Bash が実行された） |

- Claude はサブエージェントから `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` をもともと外すため、これらの
  除外は効果が無い。w-e2e-planner の `disallowedTools`（`AskUserQuestion` だけ）は Claude では実質の除外が無い
- `Agent` を除外すると、`--agent` 起動の init の tools からは `Task` が消える。`Bash` を除外すると `Monitor` も消える
- Windows では PowerShell ツールが自動で有効になるため、シェルを使わせないエージェントでは `Bash` と合わせて
  `PowerShell` も除外する
- Copilot でツールを制限するには、許可型の `tools` が要る（Copilot の custom agents は `disallowedTools` を持たない）。
  `tools` は許可したツール以外をすべて外すので、MCP ツール名の形がクライアントで違うことと、許可の書き忘れで作業が止まることに
  注意する。ここでは Issue #1231 の指定どおり除外型だけを使い、Copilot では制限が働かない
- `claude plugin validate --strict`（pre-commit の `plugin-validate`）は未知のキー、`argument-hint` の型、
  `disallowedTools` のツール名を確かめない。これらは `lib/tests/test_agent_definitions.py` が固定している
