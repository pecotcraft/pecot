# Feature Specification: pecot-workflow のフックを棚卸しし、状態をファイルに頼らない形にし、Claude Code の現行のプラグイン仕様に合わせる

**Feature Branch**: `025-hook-session-state`

**Created**: 2026-11-12

**Status**: Draft

**Input**: Epic pecotcraft/pecot#387。pecot-workflow のフックを要るものだけにし、状態の持ち方を見直す。当初諦めた状態管理を、現行の仕様で実現できるか確かめる。Claude Code の現行のプラグイン仕様に合わせ、GitHub Copilot CLI の動作は撤廃するもの以外変えない。

## Clarifications

### Session 2026-11-12

- Q: 外部へ反映する操作の承認（ask）と、スラッシュコマンド起点でそれを免除するフラグをどうするか → A: すべて撤廃する。対象は MCP ツールの `pr_create`・`issue_create`・`issue_quick` の実投稿と `gh pr merge` の ask、免除のフラグ 3 つ（FR-001〜FR-004）
- Q: deny で止めているガードのうち、どれを撤廃するか → A: Bash での `pecot` の起動の deny を撤廃する。ほかの deny は、棚卸しで 1 本ずつ判定する（FR-005、FR-020）
- Q: ask を撤廃した後、承認を求めたい利用者のために、プラグインはどこまで用意するか → A: 何も用意しない。権限の設定の例も載せない（FR-006）
- Q: 棚卸しの判定の表をどこに残すか → A: この spec の調査の文書に残す。README には残ったフックだけを書く（FR-020）
- Q: fork で分かれたセッションは、元のセッションの起票待ちのフラグを引き継ぐか → A: 引き継ぐ。元のセッションを特定できないときは引き継がない。のちに起票待ちのフラグごと撤廃したので、この決定は使わない
- Q: 当初できなかった状態管理の候補に、何を加えるか → A: 着手中の Issue（`.pecot-active`）をセッションごとに持つことを加える（FR-041）
- Q: リマインダーと動作安定用のフックを、どれだけ残すか → A: 残すのは 3 つだけ（のちに更新の通知も消し、2 つにした）。計画の承認の後の案内（`exit-plan-remind`）、`/tmp` の置き換えの促し（`tmp-path-warner`）、プラグインの更新の通知（`plugin-update-notice`）。ほかは撤廃する（FR-010）
- Q: プラグインの更新の通知は、Claude Code の組み込みの自動更新で代えられるか → A: 代える。通知のフックを消し、README にマーケットプレイスの自動更新を有効にする推奨設定を書く（FR-010、FR-011）
- Q: 開始時の `git pull`（`git-sync`）と自動 push（`auto-push`）をどうするか → A: `git-sync` は要るので残し、初期値を無効にする（FR-025）。`auto-push` は撤廃する（FR-010）
- Q: スキルの起動の後だけ要るフックを、どこに置くか → A: スキルの frontmatter の `hooks` に置く。起動したセッションにだけ登録され、そのセッションの終わりまで動く。状態のファイルを持たずに済む（FR-030〜FR-034）
- Q: フックで止める目的は何か → A: pecot 以外の方法で PR や Issue を作られるなど、pecot のワークフローが崩れるのを防ぐことだけ。Claude Code の安全や、ほぼ起きない失敗への備えは目的にしない（FR-007、FR-008）
- Q: Bash のコマンドが大きすぎてガードが中身を確かめられないときの ask をどうするか → A: 撤廃し、素通しにする。この端末の記録では 29,119 回のうち 1 回しか起きていない（FR-008）
- Q: GitHub MCP の PR 作成の deny（`pr-create-block`）をどうするか → A: 撤廃する（FR-007）
- Q: `--no-verify` の deny（`git-no-verify-check`）をどうするか → A: 残すが、初期値を無効にする。`-n` のまとめ書き・`core.hooksPath`・`SKIP=` などの抜けがあり、フックでは守り切れない。守りは CI に任せる。止める形は増やす（FR-009）
- Q: context7 と WebSearch を確認なしで通す allow のフック（`context7-allow`・`websearch-allow`）をどうするか → A: 撤廃する。組み込みの確認で、利用者が許可を残せる（FR-010）
- Q: Bash から起動した CLI の起点の変数を書くフック（`session-project-dir`）をどうするか → A: 撤廃する。スキルは MCP ツールを使い、使われる場面が狭い（FR-010）
- Q: 待機用のブランチ（`wt<数字>`）への直接の commit・push を止める `git-worktree-branch-check` をどうするか → A: 残して直す（FR-024）
- Q: 作業中の Issue をセッション名にする `session-title` をどうするか → A: 残す
- Q: 通知音のフック（`terminal-bell`・`pty-bell-sender`）をどうするか → A: 撤廃し、組み込みの通知の設定を README の推奨設定に書く（FR-010、FR-011）。対象は、Claude Code の通知・プッシュ通知・端末の状態の表示と、Copilot CLI の `beep`・`notifications`
- Q: 撤廃する注入のフックが足していた決まりの 3 行（指示なしに PR・マージ・Issue のクローズをしない、Step の順に従う、不明なら聞く）をスキルの本文に足すか → A: 足さない。要ると分かったらフックを戻す（FR-014）
- Q: 呼び出し元が無くなるコード（`claude-adapter`・`pecot-tool-names.sh`・`command-segments.sh`）を消すか → A: 消す（FR-013、FR-021）
- Q: Claude Code 向けの定義で撤廃したものを、Copilot CLI 向けの定義からも外すか → A: 外す（FR-061）
- Q: SessionStart の matcher に compact を足すか → A: 足す
- Q: spec 024 の tasks にある「MCP ツール `pr_merge` を確認にかける」項目をどうするか → A: 確認にかけない。024 の該当 Issue に知らせて項目を外してもらう
- Q: クイックモードのフラグ（`.pecot-quick-mode`）を Copilot CLI のために残すか → A: 残さず消す。Copilot CLI で要ると分かったら、そのとき対応を決める（FR-033）
- Q: セッション名を、着手を確定した後に 1 回だけ変える形にするか → A: 今のままにする。`sessionTitle` を返せるのは SessionStart と UserPromptSubmit だけで、名前を返すのは題名が変わったときだけになっている
- Q: Issue に紐づけたブランチを、Issue と別のリポに作るか → A: 作らない。紐づけたブランチは、作業対象のリポの Issue にだけ作る。マルチリポでは、リポごとの Issue にそれぞれブランチを作る
- Q: w-breakdown のブランチを、何の Issue に紐づけるか → A: 分解の作業をタスクの Issue として Epic の下に切る。タスクを Active に置き、ブランチを紐づける。ブランチ名は pecot の決まり（`<名前>/<タスクの番号>`）にし、speckit の名前とは揃えない
- Q: 作業中の Issue を、何から求めるか → A: git の remote とチェックアウト中のブランチ名の末尾の番号から求める。クラウドのセッションでは、手元のファイルが消えるためだ。`.pecot-active`・`create_branch` の上書きガード・`session_restore` を除く（FR-043〜FR-045）
- Q: claude-code-action が Issue から起動したときに作る `claude/…` のブランチをどう扱うか → A: 特別な扱いが要る。この Epic では扱わず、先送りする
- Q: `create_branch` の `allow_cross_repo` をどうするか → A: 要らないので除く（FR-044）
- Q: `issue_quick` の `no_branch` と、ブランチの作成に失敗しても続ける動きをどうするか → A: 今のままにする。ブランチを切らないタスクもある。そのときは作業中の Issue が無い（FR-045）
- Q: 状態管理以外のクラウド対応（プラグインの読み込み、GraphQL の拒否、`claude/…` のブランチ）をどうするか → A: この Epic では扱わず、別の Epic の起票もまだしない
- Q: `issue_quick` で、セッションのリポと違うリポを指定してブランチを作るときをどうするか → A: `create_branch` と同じく止める。`no_branch` のときは通す（FR-046）
- Q: 末尾が番号の、pecot 以外のブランチ（`release/2026` など）をどう扱うか → A: 関知しない。pecot が勧めないブランチで、番号を作業中の Issue と読むのは許す

## 背景

フックは、要否を見直されないまま増えた。

| 場面 | 今の姿 |
|---|---|
| 登録 | Claude Code 向けの定義は 6 つのイベントに 12 本のスクリプトを登録する。Copilot CLI 向けの定義は 5 つのイベントに 10 本を登録する |
| 設定キー | `hooks/README.md` の設定キーは 40 個（`hooks-config.json.sample` と同じ）。個別に無効にできる |
| #42 の後 | CLI を MCP ツールに移した。Bash で `pecot` を起動する前提のガードと案内が残っており、要否を見直していない |

止める操作と、承認を求める操作は次のとおり。

| 種類 | 操作 |
|---|---|
| deny | `gh pr create`・`gh issue create`・Bash での `pecot` の起動・GitHub MCP の `create_pull_request`・`git commit/push --no-verify`・`wt*` ブランチへの直接の commit と push |
| ask | MCP ツールの `pr_create`・`issue_create`・`issue_quick` の実投稿、`gh pr merge` |

ask は、スラッシュコマンドで起動したときだけ免除する。
普段の操作では承認を求められ、コマンドで頼んだときは求められない。利用者には、この違いが分かりにくい。

止めずに文脈を足すフック（リマインダー・動作安定用）も多い。スキルの起動や特定のコマンドのたびに、スキルの本文と重なる注意を足す。

状態は、worktree の `.pecot/state/` に置くファイルで持つ。

| ファイル | 意味 | 作る | 消す |
|---|---|---|---|
| `.pecot-active` | worktree が作業中の Issue | MCP ツール（着手） | MCP ツール（片付け） |
| `.pecot-session-title`・`session-title-sent` | セッション名に使う題名と、送った題名 | MCP ツール・フック | 上書き |
| `.pecot-quick-mode` | w-quick のプランモード中 | MCP ツール | ExitPlanMode の後のフック |
| `issue-pending` | w-quick / w-ready で、起票前に編集しようとしている | UserPromptSubmit・PostToolUse のフック | MCP ツール（起票成功）・SessionStart の掃除 |
| `pr-create-slash-pending`・`issue-create-slash-pending`・`merge-slash-pending` | スキル起点で、ask を免除する | UserPromptSubmit のフック | MCP ツール（投稿成功・片付け成功）・SessionStart の掃除 |
| `.auto-push-urls`・`.wip-branch-linked` | 自動 push の記録 | フック | フック・MCP ツール |

worktree 単位で持つことで、次の問題が起きる。

| 問題 | 起きる場面 |
|---|---|
| 他のセッションの状態が消える | SessionStart（startup・clear・resume・fork）の掃除が、同じ worktree で動いている別のセッションのフラグを消す |
| resume で状態を失う | 起票前の聞き返しの途中で中断し、resume で戻ると、フラグが消えている |
| 別のセッションに及ぶ | 片方のセッションのフラグで、もう片方のセッションの ask が免除される。リマインドも出る |
| スキルの判定が文字列頼み | スキルの実行中かどうかを、プロンプトの先頭行の `/pecot-w:w-…` で判定する。Skill ツールで起動したときと、地の文で頼んだときを拾えない |

フックの入出力は、Claude Code 2.1.310 と Copilot CLI 1.0.103 で確かめた範囲で使っている。
その後に増えたイベント・入力の項目・プラグインの設定項目とは見比べていない。
現行の Claude Code には、スキルの frontmatter に書くフックがある。スキルを起動したセッションにだけ登録される。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 外部へ反映する操作で、プラグインが承認を求めない (Priority: P1)

利用者が PR の作成・起票・マージを頼むと、どの頼み方でも、プラグインは承認を求めずに進める。
承認の要否は、プラグインの関心の外に置く。

**Why this priority**: 頼み方によって承認の有無が変わり、利用者には理由が分からない。免除のフラグと掃除の仕組みが、状態の問題の大半を生んでいる。

**Independent Test**: 4 つの操作（`pr_create`・`issue_create`・`issue_quick` の実投稿と `gh pr merge`）の hook 入力を用意する。スラッシュコマンドの有無を変えて PreToolUse に流す。どれにも ask が返らないことを確かめる。

**Acceptance Scenarios**:

1. **Given** スラッシュコマンドを使わずに頼んだ, **When** エージェントが `pr_create` を実投稿で呼ぶ, **Then** プラグインのフックは ask を返さない
2. **Given** スラッシュコマンドを使わずに頼んだ, **When** エージェントが `gh pr merge` を実行する, **Then** プラグインのフックは ask を返さない
3. **Given** エージェントが Bash で `pecot` を起動する, **When** PreToolUse のフックが動く, **Then** deny は返らない
4. **Given** 撤廃の前の版で作られた免除のフラグが残っている, **When** 新しい版で操作する, **Then** 残ったフラグは何の動作にも使われない

---

### User Story 2 - スキルの本文と重なる注意を、フックが足さない (Priority: P1)

利用者がスキルを起動しても、プラグインのフックは、スキルの本文と重なる注意や案内を会話に足さない。
残る案内は 2 つだけで、それぞれスキルの本文では代えられない理由がある。

**Why this priority**: 重なる注意は、文脈を毎回消費する。起票待ちのリマインドは、フラグとその掃除という状態の問題も生んでいる。撤廃すると、状態の問題の多くが仕組みごと無くなる。

**Independent Test**: 撤廃したフックが反応していた hook 入力を流す。プロンプト・Skill ツールの起動・起票前の Edit・`git checkout`・commit の後・セッションの開始・応答の終わりの 7 つだ。出力に撤廃した注意が無く、`.pecot/state/` にフラグが作られないことを確かめる。

**Acceptance Scenarios**:

1. **Given** 利用者が `/pecot-w:w-quick` と打った, **When** プロンプトとスキルの起動のフックが動く, **Then** 注意は足されず、起票待ちのフラグも作られない
2. **Given** 起票の前に, **When** エージェントがファイルを編集する, **Then** リマインドは出ない
3. **Given** セッションが始まる, **When** SessionStart のフックが動く, **Then** VS Code の情報・`.gitignore` の案内・プラグインの更新の通知は出ない。`git pull` は、利用者が `git-sync` を有効にしたときだけ動く
4. **Given** エージェントが Bash で `/tmp/x` を使う, **When** PreToolUse のフックが動く, **Then** 今と同じく `.pecot/work/` への置き換えが促される
5. **Given** 利用者が README を読む, **When** 更新の節を見る, **Then** pecot のマーケットプレイスの自動更新を有効にする推奨設定がある

---

### User Story 3 - 残るフックが要るものだけになり、判定が残っている (Priority: P2)

保守する人は、フックの 1 本ずつについて、残す・消す・置き換えるの判定と理由を 1 か所で読める。
判定どおりに、要らないフックと設定キーは消え、置き換えるものは置き換わっている。

**Why this priority**: User Story 1・2 で撤廃が決まったもの以外も、1 本ずつ判定する。判定の理由が残れば、次に増やすときの基準になる。

**Independent Test**: 判定の表を、2 つのクライアント向けの定義ファイルと README の設定キーと比べる。表に無いフックと、表で消すとしたのに残るフックが無いことを確かめる。

**Acceptance Scenarios**:

1. **Given** 判定の表がある, **When** 定義ファイルに登録したスクリプトと README の設定キーを列挙する, **Then** すべてが表に 1 行ずつある。判定が「消す」のものは、定義と README のどちらにも無い
2. **Given** 判定が「置き換える」のフックがある, **When** 置き換え先を見る, **Then** 利用者への同じ効果がテストで確かめられている
3. **Given** 消した設定キーを、利用者の `hooks-config.json` が持っている, **When** フックが動く, **Then** エラーにならず無視される

---

### User Story 4 - スキルの起動の後だけ要る案内が、起動したセッションにだけ出る (Priority: P2)

利用者が w-active か w-quick で計画を承認すると、そのセッションにだけ計画の更新の案内が出る。
同じ worktree の別のセッションには出ない。
w-quick では、実装の引き継ぎの案内を出さない。

**Why this priority**: 残す案内のうち、計画の承認の後の案内だけがスキルの起動に結びつく。今はクイックモードのフラグをファイルで持ち、別のセッションにも及ぶ。スキルの frontmatter のフックに移せば、ファイルを持たずに済む。

**Independent Test**: 実機で、同じ worktree に 2 つのセッションを開く。片方で w-quick を起動して計画を承認し、そのセッションにだけ案内が出て、実装の引き継ぎの案内は出ないことを確かめる。

**Acceptance Scenarios**:

1. **Given** セッション A で w-active を起動した, **When** A で計画を承認する, **Then** 計画の更新と実装の引き継ぎの案内が出る
2. **Given** セッション A で w-quick を起動した, **When** A で計画を承認する, **Then** 計画の更新の案内だけが出る
3. **Given** セッション A で w-active を起動した, **When** 同じ worktree のセッション B でプランモードを抜ける, **Then** B には案内が出ない
4. **Given** w-active の後にセッションを resume した, **When** 計画を承認する, **Then** 実機で確かめた結果のとおりに出る（登録し直されるかを記録する）
5. **Given** 当初諦めた状態管理の候補がある, **When** 現行の仕様で確かめる, **Then** 候補ごとに「実現する」「実現しない」の結論と根拠が残る

---

### User Story 5 - Claude Code の現行の版で、使っている仕様を確かめてある (Priority: P3)

保守する人は、`hooks/README.md` の対応バージョンと実機の記録で、現行の Claude Code の版で動くことを確かめられる。
使っているイベント・入出力の項目・`plugin.json` の項目は、現行の公式文書と見比べてある。

**Why this priority**: 今の動作は 2.1.310 で確かめてあり、問題は出ていない。User Story 4 の判断の根拠にもなるが、それ自体は利用者の動作を変えない。

**Independent Test**: README の対応バージョンの表と実機の記録の表を読む。確かめた日付と版があり、見比べた項目の一覧に抜けが無いことを確かめる。

**Acceptance Scenarios**:

1. **Given** 現行の公式文書, **When** 使っているイベント・入出力・`plugin.json` の項目を並べる, **Then** 項目ごとに「同じ」「変わった」「廃止された」のどれかが記録されている
2. **Given** 新しく使う仕組み（スキルの frontmatter のフック）がある, **When** README を見る, **Then** 最低対応版と、それを確かめた実機の記録がある

---

### User Story 6 - 作業中の Issue が、手元のファイルが消えても分かる (Priority: P2)

利用者がクラウドのセッションや新しい clone で作業を続けても、pecot はブランチから作業中の Issue を求める。
`.pecot/state/` が消えていても、PR の `Closes` の補完とセッション名は同じ Issue を指す。

**Why this priority**: 今後はクラウドのセッションで作業させることが増える。クラウドは毎回まっさらな clone から始まり、手元のファイルは消える。作業中の Issue をファイルで持つと、そこで pecot の流れがずれる。

**Independent Test**: `create_branch` で作ったブランチを、別の場所に clone し直して取り出す。`.pecot/state/` が無い状態で `pr_create` の下書きを作り、`Closes` が同じ Issue を指すことを確かめる。

**Acceptance Scenarios**:

1. **Given** remote は `owner/repo`、ブランチは `feat/x/387`, **When** 作業中の Issue を求める, **Then** `owner/repo#387` になる
2. **Given** `.pecot/state/` の無い clone, **When** 同じブランチで `pr_create` の下書きを作る, **Then** `Closes #387` を補う
3. **Given** ブランチは `main`, **When** `pr_create` の下書きを作る, **Then** `Closes` を補わない。`session_status` は、作業中の Issue が無いと出す
4. **Given** w-breakdown を始める, **When** 分解の作業に着手する, **Then** Epic の下にタスクを起票して Active に載せる。speckit の工程は、そのタスクに紐づいたブランチで進む

---

### Edge Cases

- スキルの frontmatter のフックは、スキルが終わっても外れない。同じセッションで w-quick と w-active の両方を起動すると、両方のフックが残る。そのときの案内の出し方は plan で決める
- GitHub Copilot CLI がスキルの frontmatter のフックを読まないと分かったときは、そのとき対応を決める。クイックモードのフラグは残さない
- resume の後にスキルの frontmatter のフックが登録し直されないときは、resume の後の計画の承認に案内が出ない。これは許す
- 撤廃の前の版で作られたフラグ（免除の 3 つと `issue-pending`）が残っていても、読む者がいないので動作に使われない
- 利用者の `hooks-config.json` に撤廃したキーが残っていても、無視する
- 末尾が番号でないブランチ（`main`、speckit の名前のブランチなど）と、ブランチを切らないタスクでは、作業中の Issue が無い。Issue が要るツールは、Issue を引数で受ける（FR-045）
- claude-code-action が作る `claude/…` のブランチは、この Epic では扱わない
- 末尾が番号の、pecot 以外のブランチ（`release/2026` など）では、その番号を作業中の Issue と読む。pecot が勧めないブランチなので、関知しない
- fork で作業し、`origin` が fork を指すときは、fork の owner/repo を作業中の Issue のリポと読む。pecot が勧めない使い方なので、関知しない
- `.pecot-session-title`・`session-title-sent`・`.plugin-sync-version` は、消えても作り直されるキャッシュや印として残す。クラウドで消えても動作は変わらない

## Requirements *(mandatory)*

### Functional Requirements

#### 承認と免除の撤廃

| ID | 要件 |
|---|---|
| FR-001 | MCP ツールの `pr_create`・`issue_create`・`issue_quick` の実投稿に、プラグインのフックが ask を返してはならない |
| FR-002 | `gh pr merge` に、プラグインのフックが ask を返してはならない |
| FR-003 | 免除のフラグ 3 つ（`pr-create-slash-pending`・`issue-create-slash-pending`・`merge-slash-pending`）と、その作成・消費・掃除の仕組みを除かなければならない。CLI と MCP ツールの消費の処理も除く |
| FR-004 | 撤廃の前の版で作られたフラグが残っていても、どの動作にも使ってはならない |
| FR-005 | Bash での `pecot` の起動に、プラグインのフックが deny を返してはならない |
| FR-006 | 承認の代わりの手段（権限の設定の例・onboarding での設定）を、プラグインは用意しない。README・スキル・エージェントの文書から、承認と免除の記述を除かなければならない |
| FR-007 | GitHub MCP の `create_pull_request` に、プラグインのフックが deny を返してはならない |
| FR-008 | Bash のコマンドが大きすぎて、ガードが中身を確かめられないときに、ask を返してはならない。ガードを通さずに素通しにする |
| FR-009 | `git-no-verify-check` は残し、初期値を無効にしなければならない。有効にしたときは、`--no-verify` に加えて、`-n` のまとめ書き・引用符で囲んだ形・`-c core.hooksPath=`・`git config core.hooksPath`・`SKIP=`・`HUSKY=0` も止めなければならない |

#### リマインダーと動作安定用のフックの撤廃

| ID | 要件 |
|---|---|
| FR-010 | 次のフックを除かなければならない。`context7-allow`・`websearch-allow`・`session-project-dir`、スキルの決まりの注入 2 つ（`workflow-compliance-injector`・`pecot-skill-compliance`）、`pecot-skill-reminder`、起票待ちの一式、`git-checkout-check`、`commit-info-display`、`misplaced-pecot-notice`、SessionStart の案内 3 つ、`auto-push`、通知音の 2 つ（`terminal-bell`・`pty-bell-sender`） |
| FR-011 | `hooks/README.md` に、推奨設定を書かなければならない。pecot のマーケットプレイスの自動更新と、両クライアントの組み込みの通知（R6）を載せる |
| FR-012 | 残すリマインダーは `exit-plan-remind`・`tmp-path-warner` の 2 つだけにしなければならない |
| FR-013 | 撤廃で何も呼ばなくなった `hooks.json` のエントリとスクリプトは、定義ファイルから除かなければならない |
| FR-014 | 撤廃したフックが書いていた決まりは、スキルの本文に移してはならない。要ると分かったときは、フックを戻して対応する |

FR-010 の内訳は次のとおり。

| まとまり | 対象 |
|---|---|
| 起票待ちの一式 | `pecot-issue-pending-state`・`pecot-issue-pending-reminder`・`issue-pending-cleanup`・`issue-pending` のフラグ |
| SessionStart の案内 3 つ | `vscode-workspace-detector`・`gitignore-track-notice`・`plugin-update-notice` |
| `auto-push` | PostToolUse と Stop の両方。`.auto-push-urls`・`.wip-branch-linked` も除く |

#### 残るフックの棚卸し

| ID | 要件 |
|---|---|
| FR-020 | 2 つのクライアント向けの定義ファイルに登録したスクリプトと、README の設定キーのすべてに、判定（残す・消す・置き換える）と理由を、この spec の調査の文書に 1 つの表で残さなければならない。`hooks/README.md` には残ったフックだけを書く |
| FR-021 | 判定が「消す」のフックと設定キーは、定義ファイル・スクリプト・テスト・README から除かなければならない |
| FR-022 | 判定が「置き換える」のフックは、置き換え先で同じ効果が出ることをテストで確かめてから除かなければならない |
| FR-023 | 利用者の `hooks-config.json` に消した設定キーが残っていても、フックはエラーにせず無視しなければならない |
| FR-024 | `git-worktree-branch-check` は残し、直さなければならない。少なくとも、今の pecot に無いブランチ名（`develop-aist`）を対象から外す |
| FR-025 | `git-sync`（開始時の `git pull`）は残し、初期値を無効にしなければならない |

#### スキルの frontmatter のフック

| ID | 要件 |
|---|---|
| FR-030 | 計画の承認の後の案内は、w-active と w-quick の frontmatter の `hooks` に置かなければならない |
| FR-031 | w-quick で起動したセッションでは、実装の引き継ぎの案内を出してはならない |
| FR-032 | スキルを起動していないセッションには、計画の承認の後の案内を出してはならない |
| FR-033 | クイックモードのフラグ（`.pecot-quick-mode`）を除かなければならない。書き手の MCP ツールと片付けの処理からも除く |
| FR-034 | スキルの frontmatter のフックについて、3 点を実機で確かめて README に記録しなければならない。プラグインのスキルで登録されるか、resume の後の扱い、Copilot CLI での扱いだ |

#### 当初諦めた状態管理

| ID | 要件 |
|---|---|
| FR-040 | 当初ファイルの制約で諦めた状態管理の候補を挙げ、候補ごとに現行の仕様で実現できるかの結論と根拠を残さなければならない |
| FR-041 | FR-040 の候補には、少なくとも次の 3 つを含めなければならない。スキルの起動と終了でスキルの実行中を判定する。セッションの終了でその状態を片付ける。着手中の Issue（`.pecot-active`）をセッションごとに持つ |
| FR-042 | 実現すると結論した候補は、実装しなければならない |

#### 作業中の Issue

| ID | 要件 |
|---|---|
| FR-043 | 作業中の Issue は、git の remote の owner/repo と、チェックアウト中のブランチ名の末尾の番号から求めなければならない。手元の状態のファイルに頼ってはならない |
| FR-044 | `.pecot-active`、`create_branch` の上書きガード（`force_overwrite_active` を含む）と `allow_cross_repo`、`session_restore` を除かなければならない。読み手（`pr_create` の `Closes` の補完、`session_status`、`session-title`、`exit-plan-remind`、`w-implementer` の編集してよいリポ）は FR-043 の求め方に移す |
| FR-045 | 末尾が番号でないブランチと、ブランチを切らないタスクでは、作業中の Issue を無いものとして扱わなければならない。Issue が要るツールは、Issue を引数で受ける |
| FR-046 | Issue に紐づけたブランチは、セッションのリポの Issue にだけ作らなければならない。`create_branch` と、ブランチを作る `issue_quick` は、リポが違えば止める。`no_branch` の `issue_quick` は通す |
| FR-047 | w-breakdown は、分解の作業をタスクの Issue として Epic の下に起票し、Active に置き、そのタスクに紐づけたブランチで speckit の工程を動かさなければならない。speckit の git 拡張でブランチを作ってはならない |

#### プラグイン仕様への追従

| ID | 要件 |
|---|---|
| FR-050 | 使っている hook のイベント・matcher・入出力の項目と、`plugin.json`・`hooks.json` の項目を、現行の公式文書と見比べて項目ごとに記録しなければならない |
| FR-051 | 見比べて、変わった・廃止されたとわかった項目は、現行の仕様に合わせて直さなければならない |
| FR-052 | README の対応バージョン（最低対応版と根拠）と実機の記録を、確かめた現行の版に更新しなければならない |

#### GitHub Copilot CLI

| ID | 要件 |
|---|---|
| FR-060 | Copilot CLI での利用者から見た動作は、撤廃したものと棚卸しの判定によるもの以外、変えてはならない |
| FR-061 | 撤廃と棚卸しの判定は、Copilot CLI 向けの定義ファイルにも同じく反映しなければならない |

### Key Entities

| 名前 | 中身 |
|---|---|
| フックの判定 | フック（スクリプトか設定キー）ごとの行。判定、理由、置き換え先、対象のクライアントを持つ |
| スキルの frontmatter のフック | スキルの起動で、そのセッションにだけ登録されるフック。セッションの終わりまで残る |
| 作業中の Issue | git の remote とブランチ名の末尾の番号から求める値。ファイルに持たない |
| 仕様の確認の記録 | 項目（イベント・入出力・設定）ごとの行。現行の公式文書での扱いと、確かめた版・日付を持つ |

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | 基準 |
|---|---|
| SC-001 | PR の作成・起票・マージで、プラグインのフックが承認を求める件数が、頼み方によらず 0 になる |
| SC-002 | 消えると動作が変わる状態のファイルが 0 になる。残るのは、消えても作り直されるキャッシュと印だけになる |
| SC-003 | スキルを起動していないセッションに、計画の承認の後の案内が出る件数が 0 になる |
| SC-004 | 初期値の設定で、フックが会話に足す注意・案内の種類が、計画の承認の後の案内と `/tmp` の促しの 2 つになる |
| SC-005 | 定義ファイルに登録したスクリプトと README の設定キーのうち、判定の表に無いものが 0 件になる |
| SC-006 | 当初諦めた状態管理の候補のすべてに、結論と根拠がある |
| SC-007 | Copilot CLI での deny・allow の結果が、撤廃と判定によるもの以外、変更の前後のテストで 1 件も変わらない |

## Assumptions

- スキルの frontmatter のフックは、公式文書（hooks の「Hooks in skills and agents」）のとおり、スキルの起動で登録され、セッションの終わりまで残る。プラグインのスキルでも登録されることは実機で確かめる
- 承認の撤廃とリマインダーの撤廃の後、外部への反映と手順を守らせる手段は、スキルの本文だけになる。スキルの本文の「明示の指示なしに PR を作らない」などの決まりは、この Epic では変えない
- 実機で確かめるのは、Claude Code と Copilot CLI の現行の版である。確かめ方は、既存の実機の記録の形を引き継ぐ
- Copilot CLI 側の Agent Plugins 準拠の表記と構成は Epic #41 で扱い、この Epic の範囲に入れない
- spec 024（Epic #47）の tasks にある「`pr_merge` を確認にかける」項目は、この Epic の撤廃と食い違う。024 の該当 Issue に知らせて外してもらう
