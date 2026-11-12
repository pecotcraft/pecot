# Research: pecot-workflow のフックの棚卸しと状態の持ち方

**Feature**: [spec.md](spec.md) | **Date**: 2026-11-12

調べた範囲は 4 つある。

- 現行の Claude Code の公式文書（hooks・plugins-reference・skills・settings・cloud-environments・changelog）。changelog は 2.1.311〜2.1.322 を読んだ
- claude-code-action と GitHub Copilot CLI 1.0.109 の公式文書
- このリポの main（#351 の後）の `plugins/pecot-workflow/`。`hooks/`・`cli/src/`・スキル・エージェント・定義書を読んだ
- このリポの `.specify/`（speckit の設定とスクリプト）

「実機で確かめる」と書いた点は、文書で確かめられなかったものだ。確かめる手順は [quickstart.md](quickstart.md) に置く。

## R1. フックの判定（FR-010、FR-020）

設定キーは、README の表と `hooks-config.json.sample` で同じ 40 個ある。

### hooks.json に登録したスクリプト

| 名前 | イベント | 判定 | 理由 |
|---|---|---|---|
| `pre-tool-use.sh` | PreToolUse（Edit 系・EnterPlanMode） | 消す | 呼ぶのは起票待ちのリマインドだけで、それを撤廃する |
| `pre-tool-use-bash.sh` | PreToolUse（Bash） | 残す | 残る deny と `tmp-path-warner` |
| `pre-tool-use-mcp.sh` | PreToolUse（MCP） | 消す | 呼ぶものが無くなる（ask・`pr-create-block`・`context7-allow` を撤廃） |
| `pre-tool-use-skill.sh` | PreToolUse（Skill） | 残す | `.pecot` の初期化。`pecot-skill-compliance` は外す |
| `pre-tool-use-websearch.sh` | PreToolUse（WebSearch） | 消す | 呼ぶのは `websearch-allow` だけで、それを撤廃する |
| `post-tool-use-skill.sh` | PostToolUse（Skill） | 消す | 呼ぶのは `pecot-skill-reminder` だけで、それを撤廃する |
| `post-tool-use-bash.sh` | PostToolUse（Bash） | 消す | 呼ぶのは `commit-info-display` と `auto-push` だけで、両方を撤廃する |
| `post-tool-use-exit-plan-mode.sh` | PostToolUse（ExitPlanMode） | 置き換える | w-active・w-quick の frontmatter のフックに移す（R2）。両クライアントの定義から外す |
| `session-start.sh` | SessionStart | 残す | `session-title`・`.gitignore` の補完・`git-sync` が残る |
| `user-prompt-submit.sh` | UserPromptSubmit | 残す | `.pecot` の初期化の検出だけが残る |
| `user-prompt-submit-title.sh` | UserPromptSubmit | 残す | セッション名 |
| `stop.sh`・`stop-copilot.sh` | Stop | 消す | 呼ぶものが無くなる（通知音・`auto-push`・`misplaced-pecot-notice` を撤廃） |
| `notification.sh` | Notification | 消す | 呼ぶのは通知音だけで、それを撤廃する |

### 設定キーとサブスクリプト

| 名前 | 判定 | 理由 |
|---|---|---|
| `pecot-pr-create-ask`・`pecot-issue-create-ask`（`pecot-post-ask.sh`） | 消す | 承認の撤廃 |
| `gh-pr-merge-ask`（`external-post-check.sh`） | 消す | 同上 |
| `pr-create-slash-flag`・`issue-create-slash-flag`・`merge-slash-flag`（`create-slash-flag.sh`） | 消す | 同上 |
| `create-slash-cleanup` | 消す | 同上 |
| `pecot-cli-deny` | 消す | Bash の `pecot` の deny の撤廃 |
| `workflow-compliance-injector`・`pecot-skill-compliance` | 消す | リマインダーの撤廃。決まりの 3 行はスキルの本文にも移さない（R4） |
| `pecot-skill-reminder` | 消す | リマインダーの撤廃 |
| `pecot-issue-pending-state`・`pecot-issue-pending-reminder`・`issue-pending-cleanup` | 消す | 同上 |
| `git-checkout-check` | 消す | 同上。衝突するときは git が止める |
| `commit-info-display` | 消す | 同上。`git commit` の出力と重なる |
| `misplaced-pecot-notice` | 消す | 同上 |
| `vscode-workspace-detector`・`gitignore-track-notice`・`plugin-update-notice` | 消す | 同上。更新は組み込みの自動更新に代える（R6） |
| `git-sync` | 残す（初期値を無効に変える） | 開始時に最新化したい利用者が有効にする |
| `auto-push`（PostToolUse と Stop）・`branch-guard` | 消す | `branch-guard` を使うのは `auto-push` だけ |
| `core/pecot-tool-names.sh`・`core/command-segments.sh` | 消す | 使うのは消すスクリプトだけ |
| `claude-adapter` | 消す | 本番では呼ばれず、テストだけが呼ぶ |
| `exit-plan-remind` | 置き換える | R2 |
| `tmp-path-warner` | 残す（変えない） | 本文だけでは守られにくい習慣で、出す条件も狭い |
| `gh-pr-create-check`・`gh-issue-create-check` | 残す | pecot 以外の方法での PR・Issue の作成を止める。フックの目的そのもの |
| `pr-create-block` | 消す | GitHub MCP の PR 作成を止めるもの。不要とした |
| `git-worktree-branch-check` | 残して直す | 待機用のブランチへの直接の commit・push を止める。昔の名残の `develop-aist` が対象に残っている |
| `git-no-verify-check` | 残す（初期値を無効に変える） | 抜け道が多く、フックでは守り切れない。守りは CI に任せる。有効にしたときに止める形を増やす |
| `context7-allow`・`websearch-allow` | 消す | 利用者が組み込みの確認で許可を残せる |
| `tech-advisor-clone-allow` | 残す | 決まった形の clone だけを確認なしで通す |
| `claude-bash-guards` | 残す | 大きすぎるコマンドの ask は消し、素通しにする |
| `session-title` | 残して直す | 作業中の Issue をセッション名にする。番号をブランチ名から求める（R7） |
| `session-project-dir` | 消す | 使われる場面が狭い。スキルは MCP ツールを使う |
| `terminal-bell`・`pty-bell-sender` | 消す | 組み込みの設定で同じことができる（R6） |
| `pecot-dir-init*`・`pecot-gitignore-ensure`・`pecot-state-guard` | 残す | `.pecot` の初期化。`pecot-gitignore-ensure` は CLI も呼ぶ |
| `core/mcp-guidance.sh` | 残す | ask とリマインドの案内の関数を消し、deny の案内だけを残す |

`tmp-path-warner` は、Claude Code の scratchpad（`/tmp/claude-…`）も除外しない。消える・溜まる・利用者に見えない点が `/tmp` と同じためだ。
大きすぎるコマンド（60,000 バイト超）は、この端末の記録で 29,119 回のうち 1 回だった。

### 他の spec との重なり

| spec | 重なる点 | 扱い |
|---|---|---|
| 024（Epic #47）の tasks | `pecot-post-ask.sh` で、MCP ツール `pr_merge` を確認にかける項目がある | 確認にかけない。024 の該当 Issue に知らせて項目を外してもらう |
| 020（Epic #42）の #351 | `cli-node/` を `cli/` に移し、Python の CLI を消す | main に入った（#388）。この plan のパスとテストは、移した後の形で書く |

## R2. スキルの frontmatter のフック（FR-030〜FR-034）

公式文書（hooks の「Hooks in skills and agents」）の記述は次のとおり。

| 項目 | 内容 |
|---|---|
| 書き方 | SKILL.md の frontmatter の `hooks:`。settings のフックと同じ形 |
| 登録 | 利用者か Claude がスキルを起動したとき。`-p` の実行でも登録される |
| 外れる時点 | セッションの終わり。`once: true` なら最初の成功の後 |
| プラグインのスキル | 制限のある設定（`strictPluginOnlyCustomization`）の下でも、frontmatter のフックを保つ |

**Decision**:

- w-active と w-quick の frontmatter に、PostToolUse（ExitPlanMode）のフックを `once: true` で書く
- 2 つは同じスクリプトを呼び、引数で出し分ける。w-active は計画の更新と実装の引き継ぎ、w-quick は計画の更新だけを出す
- 同じセッションで両方を起動しても、起動のたびに 1 回ずつ出る
- 作業中の Issue の有無は、ブランチ名から求める（R7）。両スキルとも、checkout はプランモードより前にある

**Rationale**: どのセッションのものかを、フックの登録先が決める。状態のファイルと掃除が要らない。スラッシュコマンドと Skill ツールのどちらで起動しても同じになる。

**実機で確かめる点**:

| 点 | 確かめられないときの扱い |
|---|---|
| プラグインのスキルの frontmatter のフックが登録されるか | 登録されなければ、今の `hooks.json` の `exit-plan-remind` を残す |
| `command` で `${CLAUDE_PLUGIN_ROOT}` が展開されるか | 展開されなければ、スキルのディレクトリからの相対のパスを使う |
| `once: true` で PostToolUse（ExitPlanMode）のフックが外れるか | 外れなければ、引数の出し分けだけにし、重なりは許す |
| resume の後に登録し直されるか | されなければ、resume の後の承認に案内は出ない（spec の Edge Cases で許した） |
| GitHub Copilot CLI が frontmatter のフックを読むか | 結果を記録する。読まないときの対応は、そのとき決める |

**クイックモードのフラグ**: `.pecot-quick-mode` は消す。`issue_quick` は書かず、`pr_cleanup` の片付けからも外す。

**Alternatives considered**:

| 案 | 採らない理由 |
|---|---|
| `.pecot/state/sessions/<session_id>/` にフラグを置く | ファイルと掃除が残る。クラウドのセッションでは消える |
| スキルの本文で `${CLAUDE_SESSION_ID}` を MCP ツールに渡す | すべての呼び出しにエージェントが値を書く必要がある |

## R3. 当初諦めた状態管理の結論（FR-040〜FR-042）

| 候補 | 結論 | 根拠 |
|---|---|---|
| スキルの起動と終了で、スキルの実行中を判定する | 起動は実現する（R2）。終了は実現しない | 起動は frontmatter のフックの登録で拾える。終了のイベントは文書に無い。`once: true` で、用が済んだ時点で外す |
| セッションの終了で、その状態を片付ける | 実現しない（不要になった） | 撤廃と R2 で、片付けるセッションの状態が残らない |
| 着手中の Issue（`.pecot-active`）をセッションごとに持つ | 実現しない。ファイルをやめ、ブランチ名から求める（R7） | 着手中の Issue は、worktree のブランチと 1 対 1 だ。セッションごとにすると、ブランチとずれる |

## R4. 撤廃した決まりの移し先（FR-014）

| 撤廃するフックの文 | 移し先 |
|---|---|
| 「指示なしに PR の作成・マージ・Issue のクローズをしない」「スキルの Step の順に従う」「不明なら聞く」 | 移さない。要ると分かったらフックを戻す |
| 「作業はすべて Issue で追う」「ヒアリング → 定型作業 → プランモード」 | w-quick・w-ready の本文の手順にある。移さない |
| 起票前の編集のリマインド | w-quick・w-ready の本文の Step の順にある。移さない |

## R5. GitHub Copilot CLI（FR-060、FR-061）

| 点 | 扱い |
|---|---|
| 撤廃したフック | Copilot CLI 向けの定義からも外す |
| `exit-plan-remind` | Copilot CLI 向けの定義からも外す。frontmatter のフックを読まないと分かったら、そのとき対応を決める |
| `session-title` | 今も Copilot CLI 向けの定義に無い。変えない |
| 作業中の Issue | MCP ツールの求め方は、クライアントによらず同じになる |

## R6. 現行の仕様との見比べ（FR-050〜FR-052）

| 項目 | 現行の扱い | 対応 |
|---|---|---|
| `session_id`・`transcript_path`・`cwd` | 全イベントの共通の入力 | 同じ |
| SessionStart の `source` | startup・resume・clear・compact・fork | matcher に compact を足す。compact では `sessionTitle` が反映されないので、セッション名は出さない |
| `sessionTitle` | 返せるのは SessionStart（startup・resume・fork）と UserPromptSubmit だけ | 同じ。PostToolUse では返せないので、着手の直後に 1 回だけ変える形は採れない |
| `terminalSequence` | 許されるのは OSC の 0・1・2・9・99・777 と BEL | 使わなくなる（通知音のフックを撤廃） |
| `permissionDecision` | allow・deny・ask に defer が増えた | 変わった。defer は使わない |
| PreToolUse の上位の `decision` | 非推奨 | 使っていないことを確かめる |
| `CLAUDE_ENV_FILE` | SessionStart などで使える | 使わなくなる（`session-project-dir` を撤廃） |
| Notification の matcher | 14 の値 | 使わなくなる |
| スキルの frontmatter の `hooks`・`once` | 使える | 使う（R2） |
| UserPromptExpansion・SessionEnd | 新しいイベント | 使わない |
| hook の `if`・`statusMessage`・`async` | 新しい項目 | 使わない |
| `plugin.json` | 既定の位置の `hooks/hooks.json` は宣言なしで読まれる | 今の 4 項目のままにする |
| プラグインの自動更新 | マーケットプレイスごとに有効にできる。公式以外は初期値が無効 | README に推奨設定として書き、`plugin-update-notice` を消す |
| 通知（Claude Code） | `preferredNotifChannel` の初期値 `auto` が通知を出すのは iTerm2・Ghostty・Kitty だけ。`terminal_bell` でどの端末でも BEL を鳴らす | README に推奨設定として書き、`terminal-bell` を消す |
| プッシュ通知（Claude Code） | `inputNeededNotifEnabled` と `agentPushNotifEnabled`。Remote Control の接続中だけ届く | README に推奨設定として書く |
| 端末の状態の表示（Claude Code） | OSC 7501 で作業中・入力待ち・完了を端末に伝える（2.1.295 以降）。`terminalProgressBarEnabled` で進捗を出す | README に、対応する端末なら設定なしで出ることを書く |
| 通知（Copilot CLI） | `beep`（初期値は無効）、`notifications`・`terminalNotifications`（初期値は無効） | README に推奨設定として書き、`pty-bell-sender` を消す。`beep` がターンの完了で鳴るかは実機で確かめる |

README の最低対応版は、frontmatter のフックを実機で確かめた版に上げる。

## R7. 作業中の Issue の求め方（FR-043〜FR-046）

### 今の姿

| 役割 | 場所 | 中身 |
|---|---|---|
| 書き手 | `commands/work-target.ts` の `recordWorkTarget` | `.pecot-active`（`owner/repo/N`）と `.pecot-session-title` を書き、`.pecot/work/<N>/` を作る |
| 書き手の呼び出し元 | `create_branch`・`issue_quick`・`session_restore` | リモートにブランチを作った時点で書く。checkout より前だ |
| 上書きガード | `commands/repository.ts` の `guardActiveOverwrite` | `.pecot-active` が別の OPEN の Issue なら終了コード 2。`force_overwrite_active` で外す |
| リポの確認 | `commands/repository.ts` の `rejectCwdRepositoryMismatch` | セッションのリポと Issue のリポが違えば終了コード 2。`allow_cross_repo` で外す |
| 読み手 | `commands/pr.ts`（`Closes` の補完） | `.pecot-active` を読み、無ければブランチ名の末尾の番号を使う |
| 読み手 | `commands/session.ts`（`session_status`） | フラグの表と、`.pecot-active` の Issue の題名・状態を出す。ブランチ名からの番号も別に出す |
| 読み手 | `hooks/lib/core/session-title.sh` | `.pecot-active` の番号と `.pecot-session-title` の題名でセッション名を返す |
| 読み手 | `hooks/lib/post-tool-use/exit-plan-remind.sh` | `.pecot-active` が無ければ何も出さない |
| 読み手 | `agents/w-implementer.md`・`w-help/references/issue-flow-rules.md` §6 | 編集してよいリポを `.pecot-active` の owner/repo で決める |
| 消し手 | `commands/pr.ts`（`pr_cleanup`） | `.pecot-active`・`.pecot-session-title`・`.pecot-quick-mode`・`.wip-branch-linked` を消す |

ブランチ名の末尾の番号を読む関数は、既にある（`domain/branch-name.ts` の `extractIssueNumberFromBranch`）。
`createLinkedBranch` は Issue の node ID だけを渡すので、ブランチは Issue と同じリポにできる。

### Decision

- 作業中の Issue は、関数 1 つで求める。入力はディレクトリで、出力は `owner/repo` と番号の組か「無い」だ
- owner/repo は、主の remote（`primaryRemoteRepository`）から取る。番号は、チェックアウト中のブランチ名の末尾の区切りから取る
- MCP ツールは、セッションを始めたリポ（MCP サーバの作業ディレクトリ）で求める。`directory` を受けるツールは、そのディレクトリで求める
- フックは、`CLAUDE_PROJECT_DIR` のブランチ名から番号だけを求める。セッション名と案内の出し分けに、owner/repo は要らない
- `recordWorkTarget` は、題名のキャッシュ（`.pecot-session-title`）と作業ディレクトリだけを作る形に直す。結果の行も、それに合わせる
- `create_branch` から、上書きガード・`force_overwrite_active`・`allow_cross_repo` を除く。リポが違うときは、いつも止める
- `session_restore` を除く。コマンド・MCP ツール・定義書・テスト・文書から消す
- `session_status` は、フラグの表をやめ、求めた作業中の Issue とその題名・状態を出す
- `pr_cleanup` が消すのは、`.pecot-session-title` だけになる

**Rationale**:

- ブランチと remote は、clone し直しても残る。クラウドのセッションは毎回まっさらな clone から始まり、`.pecot/state/` は消える
- 着手の合図が「リモートにブランチを作った」から「そのブランチを checkout した」に変わる。上書きされるものが無いので、上書きガードは要らなくなる
- ブランチを切り替えると、作業中の Issue も切り替わる。片付けを通さずに残る古い値（stale）が無くなる

### 変わる振る舞い

| 場面 | 今 | 変更の後 |
|---|---|---|
| `create_branch` の直後、checkout の前 | 作業中の Issue が決まっている | まだ無い（前のブランチのまま）。checkout で決まる |
| `issue_quick` を `no_branch` で呼んだ | 作業中の Issue が決まる | 無い。題名のキャッシュも書かない |
| 待機用のブランチ（`wt4` など）に戻った | `.pecot-active` が残る | 無い |
| まっさらな clone で同じブランチを取り出した | 無い（`session_restore` が要る） | ある。セッション名は題名のキャッシュが無いので `#<番号>` だけになる |
| 末尾が番号の、pecot 以外のブランチ（`release/2026` など） | `.pecot-active` が無いときだけ `#2026` と読む | いつも `#2026` と読む |

### ユーザーの判断

| 点 | 決定 |
|---|---|
| `issue_quick` で、セッションのリポと違うリポを指定したとき | ブランチを作るとき（`no_branch` でないとき）は、`create_branch` と同じく止める。`no_branch` のときは通す |
| 末尾が番号の、pecot 以外のブランチ | 関知しない。pecot が勧めないブランチだ |

**Alternatives considered**:

| 案 | 採らない理由 |
|---|---|
| `.pecot-active` を残し、無いときだけブランチから求める | 2 つの求め方が食い違う場面（ブランチの切り替え・古い値）が残る |
| ブランチ名ではなく、GitHub の「紐づけたブランチ」を API で引く | フックから呼べない。クラウドでは GraphQL が拒否される（R9） |
| git の設定（`branch.<名前>.pecot-issue`）に書く | clone し直すと消える |

## R8. w-breakdown と speckit のブランチ（FR-047）

### 今の姿

- w-breakdown は、タスクを起票せずに speckit を動かす。ブランチは、speckit の git 拡張が `NNN-<名前>` で作る
- `.specify/extensions.yml` の `before_specify` に、`speckit.git.feature` が必須（`optional: false`）で登録されている
- speckit の本体は、対象のディレクトリを `.specify/feature.json` から求める。ブランチ名には頼らない
- `.specify/feature.json` は `.specify/.gitignore` で追跡の外にある
- ブランチ名が `NNN-` で始まることを求めるのは、任意の `speckit.git.validate` だけだ

`create-new-feature-branch.sh` は、次のように動く。

| 入力 | 動き |
|---|---|
| `GIT_BRANCH_NAME` を渡す | その名前をそのまま使う。番号と名前の生成を飛ばす |
| `--allow-existing-branch` を付け、今のブランチと同じ名前を渡す | 何もせずに成功し、`BRANCH_NAME` を返す |

### Decision

- w-breakdown は、対象の Epic を決めた後、`issue_quick` を `parent_epic` 付きで呼ぶ。分解の作業のタスクができ、Active に載り、紐づいたブランチができる
- そのブランチ（`feat/<日時>/<番号>`）を checkout してから、speckit の工程を始める
- speckit の git 拡張がブランチを作る場面では、`GIT_BRANCH_NAME` に今のブランチ名を渡し、`--allow-existing-branch` を付ける。新しいブランチは作らせない
- git 拡張を入れていないリポでは、何もしなくてよい
- 再開で `.specify/feature.json` が無いときは、`specs/` の該当のディレクトリを指す形で書き直してから続ける
- 成果物は、w-pr でタスクを閉じる PR にする

**Rationale**: `issue_quick` が、起票・Epic への紐づけ・Active・ブランチの作成を 1 回で済ませる。足す実装は、スキルの本文だけになる。

**実機で確かめる点**: `GIT_BRANCH_NAME` と `--allow-existing-branch` で、`speckit.git.feature` が新しいブランチを作らずに通るか。

## R9. クラウドのセッションの制約（記録だけ。この Epic では扱わない）

状態管理より外のクラウド対応は、この Epic で扱わない。調べた事実を、次に扱うときのために残す。

| 環境 | 事実 |
|---|---|
| Claude Code on the web | リポが宣言したプラグイン（`enabledPlugins`・`extraKnownMarketplaces`）は入らない |
| 同上 | リポの `.claude/settings.json` のフック、`.mcp.json`、`.claude/skills`、`.claude/agents` は読まれる |
| 同上 | GitHub の GraphQL は 403 で拒否される（`gh issue`・`gh pr` も）。Projects v2 に届かない。REST は通る |
| 同上 | セッションごとにまっさらな clone から始まる。VM の回収で、手元のファイルは消える |
| 同上 | 環境変数 `CLAUDE_CODE_REMOTE=true`・`CLAUDE_CODE_REMOTE_SESSION_ID` がある |
| claude-code-action | `plugins`・`plugin_marketplaces` の入力でプラグインを入れられる |
| 同上 | Issue から起動すると、`claude/…` のブランチを毎回新しく作る。開いた PR から起動すると、その PR のブランチに push する |
| 同上 | 既定の App の権限に、Projects は無い |

この Epic が扱うのは、「手元のファイルが消える」の 1 点だ。R7 で、作業中の Issue を git から求める形に変える。
残る状態のファイルは、消えても作り直されるものだけになる（[data-model.md](data-model.md)）。
