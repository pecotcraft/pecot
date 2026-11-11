# Feature Specification: pecot-workflow の TypeScript 化と MCP 化（再設計）

**Feature Branch**: `020-workflow-ts-mcp`

**Created**: 2026-11-05

**Updated**: 2026-11-11（spec 021・022 の後の前提に合わせた）

**Status**: Draft

**Input**: Epic pecotcraft/pecot#42。旧リポの spec 015（`pecotcraft/aist-roadmap:specs/015-aist-workflow-mcp/`）を基準に、移行後のリポと配布の形に合わせて残りの工程を設計し直す。

## 背景

pecot-workflow だけが Python で動き、スキルは Bash から `pecot` を呼ぶ。pecot-visual と pecot-tools は Node で動き、MCP ツールで呼ばれる。

| | pecot-workflow（現在） | pecot-visual / pecot-tools |
|---|---|---|
| 実行環境 | Python 3.10 以上と uv。データ置き場に venv を作る | Node。データ置き場に実行用ミラーを作る |
| スキルからの呼び方 | Bash で `pecot <command>` | MCP ツール |
| データ置き場 | Bash の CLI は `PLUGIN_DATA` を受け取れない。Copilot CLI では既定の場所を使う | MCP サーバの起動時に、クライアントが `CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA` で渡す |
| hooks のガード | Bash の入力にある `pecot issue create` / `pecot pr create` の文字列を見る | MCP の dispatcher（`hooks/lib/mcp-handlers/`） |
| manifest | 旧形式 `.github/plugin/plugin.json` が `hooks/hooks-copilot.json` を指す | root に Agent Plugins 1.0 の `plugin.json` と `mcp.json` |
| 単体配布 | 無い | npm の `@pecot/visual-mcp` / `@pecot/tools-mcp` |

規模: Python の CLI のソースは約 16,200 行、テストは約 33,700 行。hooks は shell と jq で約 3,600 行、テストは pytest で約 17,100 行。
スキル・agents・hooks テンプレートの 27 ファイルが `pecot <サブコマンド>` を 201 箇所に書く（2026-11-11 に数えた。`$PECOT` の変数は 0 箇所）。
サブコマンドは 34 個で、定義書（`plugins/pecot-workflow/interface/`）の項目と 1 対 1 に対応する。

### 旧 spec 015 からの引き継ぎと変更

旧リポで計画した 14 フェーズのうち、Phase 1〜3 は旧リポで済み、成果物がこのリポにある。

| 済んだもの | 置き場 |
|---|---|
| 移行前の基準値（CLI の行カバレッジ 91.0%、hooks のテスト 1,569 件と起動スクリプトの一覧） | `plugins/pecot-workflow/cli-node/tests/parity/baseline.json` |
| 前後比較の仕組み（偽の GitHub サーバ、一時 git リポ、シナリオと golden。2026-11-11 の時点で 228 件） | `cli-node/tests/parity/`、`cli-node/tests/fake-github/` |
| domain と infra、コマンド定義の一覧の枠 | `cli-node/src/domain/`、`cli-node/src/infra/`、`cli-node/src/commands/registry.ts` |

残りのフェーズは sub-issue #17〜#27 として登録されていた。本文が旧リポの番号・パス・配布先のままだったので、2026-11-05 に not planned で close した。この spec はそれらを置き換える。

| 項目 | 旧 spec 015 | この spec |
|---|---|---|
| 単体配布 | git リポ（`aist-workflow-mcp`）を `npx -y git+...` で入れる | npm の `@pecot/workflow-mcp`。pecot-visual / pecot-tools と同じ `publish-npm.yml` の trusted publishing で出す |
| speckit 成果物の置き場 | 別のロードマップリポ | `pecotcraft/pecot` の `specs/020-workflow-ts-mcp/` |
| Agent Plugins 1.0 の共通部分 | 旧 #188 に残す | Epic #41 に残す。pecot-workflow 分の manifest 移行はこの spec |
| 基準値と前後比較 | Phase 1〜2 で作る | 済み。基準値は書き換えない。golden は Python を変える PR でだけ記録し直す（FR-007） |

旧 spec 015 の clarify の決定は、すべて引き継ぐ（FR-004、FR-008、FR-012〜FR-016 に反映）。

### spec 021・022 の後に変わった前提（2026-11-11）

この spec を書いた後に、spec 021（CLI の出力の共通の関数）と spec 022（インタフェース定義書）が main に入った。

| 項目 | 2026-11-05 の記述 | 今 |
|---|---|---|
| サブコマンドの数 | 32 個 | 34 個。グループ無しの `security-sync`・`dependabot-sync` が増え、`pr merge` は `pr cleanup` に替わった |
| 公開面の正 | `contracts/mcp-tools.md` | 定義書 `plugins/pecot-workflow/interface/`（`authored.yaml` と `generated.json`）。`contracts/mcp-tools.md` は定義書に従う |
| 前後比較のシナリオ | 213 件 | 228 件。Python を変える PR が、その PR の中で足し、記録し直してきた |
| CLI の出力 | コマンドごとに直接書く | Python は共通の出力の関数（`cli/commands/_output.py`）を通す。Node にも同じ関数（`cli-node/src/commands/output.ts`）がある |
| 振る舞いの項目とテスト | つながりは無い | 定義書の振る舞いの項目 746 個が、pytest の `verifies` でテストにつながる。つながるテストの無い項目は `lint-defs` が止める |
| スキルからの呼び方 | `$PECOT` とランチャー変数 | 素の `pecot <サブコマンド>` |

移行の前後の一致は、次の 2 つで確かめる。

- 出力・終了コード・書き込み — 前後比較のシナリオと golden（FR-007）
- 公開面（コマンド名・入力・CLI の形） — 定義書（FR-019〜FR-021）

2026-11-05 に、今の Python の CLI で 213 件を流して golden と比べた。差は 12 件で、誤りは 0 件だった。12 件はすべて `--help` と使い方エラーの表示で、依存の typer が 0.27.3 に上がって書式が変わったことによる。処理の結果に差は無い。
その後 golden は何度か記録し直されているので、この 12 件の差が今も残るかは plan で計り直す。

## Clarifications

### Session 2026-11-05

- Q: 移行の途中に Python の CLI が変わったら、golden と Node はどうするか → A: Python を変える PR で Node も同じように直す。同じ PR で、該当シナリオの golden を記録し直す。
  それ以外の理由で golden は書き換えない。Python の依存の更新（dependabot を含む）も Python を変える PR に含める。typer の更新でずれた 12 件は、着手の最初に今の Python で記録し直す
- Q: 既存の sub-issue #17〜#27 をどう置き換えるか → A: not planned で close する。新しい Issue は tasks から w-issueize で作る。着手が先になるため、後継を作る前に close した。コメントには再設計で計画を作り直したことを書いた
- Q: 移行が終わるまで Python の依存を dependabot で更新し続けるか → A: 切り替えまで版の更新の対象から外す。脆弱性の alert が出たものだけを手で上げ、golden の記録し直しと合わせる

### Session 2026-11-11

- Q: spec 021・022 の後の前提を、新しい spec に書くか、この spec を直すか → A: この spec を直す。成果物の置き場を 1 つに保つ。plan・tasks も同じディレクトリで作り直す
- Q: 定義書の書き出しの元を Python から Node に替えるのは、どの時点にするか → A: 切り替えのリリースの PR で替える。
  それまで定義書は、利用者に届いている Python の CLI を写し続ける。34 個が Node にそろっても、切り替えまでは Node は比べるだけにする
- Q: 定義書の振る舞いの項目を Node のテストにつなぐ作業は、いつ行うか → A: コマンドを Node に移す各フェーズで、そのコマンドの項目を Node のテストにもつなぐ。
  Python を消すまでは pytest と Node の両方につながる。Python を消すフェーズは、pytest の側を消すだけにする
- Q: 振る舞いの項目につなぐ Node のテストは、どの種類にするか → A: 今つながっている pytest のケースと同じことを確かめる vitest のケースを書き、それにつなぐ。
  前後比較のシナリオ（golden との比較）にはつながない。1 シナリオは出力の全体を見るので、落ちた項目を示せないため

## User Scenarios & Testing *(mandatory)*

### User Story 1 - CLI が Node で動き、振る舞いが変わらない (Priority: P1)

pecot-workflow の CLI を Node に移す。コマンド名・引数・出力・終了コードは今と同じ。利用者は Node だけで pecot-workflow を使え、Python と uv を入れない。

**Why this priority**: 以降の MCP 化・hooks・スキルの書き換えは、Node の CLI が Python と同じ結果を返すことを前提にする。

**Independent Test**: 前後比較のシナリオの全件を Node の CLI に流し、golden と全部一致する。Node のコマンド定義から書き出した項目が、定義書の同じ ID の項目と入力・CLI の形で一致する。Python と uv の無い環境で `pecot project info` と `pecot issue read` が今と同じ出力を返す。

**Acceptance Scenarios**:

1. **Given** 全 34 サブコマンドの golden、**When** 同じシナリオを Node の CLI に流す、**Then** 出力・終了コード・GitHub への書き込み・状態ファイルが一致する
2. **Given** Python と uv の無い端末、**When** プラグインを入れて `pecot` を初めて実行する、**Then** データ置き場に実行用ミラーが作られ、コマンドが動く
3. **Given** データ置き場に移行前の venv がある、**When** 切り替え後の版が初めて起動する、**Then** 古い venv は使われず、片付けられる。ボードの設定とセッション状態はそのまま読める
4. **Given** Node に移したコマンド、**When** Node のコマンド定義から項目を書き出して定義書と比べる、**Then** 同じ ID の項目の入力と CLI の形の差が 0 件。差があれば、差のある項目と欄を示して失敗する
5. **Given** Node に移していないコマンド、**When** 同じ比較を流す、**Then** そのコマンドは比べる対象に入らず、失敗しない
6. **Given** 34 コマンドが Node にそろった状態、**When** 切り替えの変更で定義書の元を Node に替える、**Then** 入力と CLI の形は変わらず、MCP ツールの欄だけが増える
7. **Given** Node に移したコマンド、**When** その振る舞いの項目を数える、**Then** 全項目に ID を書いた Node のテストがある

---

### User Story 2 - スキルが MCP ツールで Issue・PR・ボードを操作する (Priority: P2)

pecot-workflow が MCP サーバを持ち、全 34 サブコマンドをツールとして公開する。スキル本文は MCP ツールを呼び、Bash で `pecot` を呼ぶ行を持たない。

**Why this priority**: Copilot CLI でデータ置き場が解決されない問題を解き、Agent Plugins 1.0 で保証される実行環境に主機能を載せる。

**Independent Test**: Claude Code と GitHub Copilot CLI で w-breakdown を実行する。Bash を使わずに `project_info` と `issue_read` の結果が得られる。

**Acceptance Scenarios**:

1. **Given** GitHub Copilot CLI、**When** スキルが MCP ツールで Issue を読む、**Then** データ置き場が解決され、止まらない
2. **Given** スキル・agents・hooks テンプレートの本文、**When** 全部を走査する、**Then** Bash で `pecot` を呼ぶ記述が 0 件
3. **Given** スキル本文にある MCP ツール名、**When** スキルのテストを流す、**Then** 全部がサーバの公開するツール一覧にある
4. **Given** 前後比較のシナリオ、**When** MCP 経由でツールを呼ぶ、**Then** 結果の本文と終了コードが CLI の golden と一致する

---

### User Story 3 - hooks のガードが MCP ツールの呼び出しを見る (Priority: P3)

Issue 作成・PR 作成などの許可・確認・阻止を、MCP ツールの呼び出しに対して行う。エージェントが Bash で `pecot` を呼ぶことは阻止し、使うべきツール名を返す。

**Why this priority**: スキルを MCP へ移すと、今のガードは働かなくなる。その抜けを残さない。

**Independent Test**: 今のガードが確認・阻止する条件で MCP ツールを呼ぶと、同じ理由で確認・阻止される。エージェントの Bash の `pecot issue read` は阻止され、`issue_read` を案内される。

**Acceptance Scenarios**:

1. **Given** 今のガードが確認・阻止する状態、**When** 該当する MCP ツールを呼ぶ、**Then** 同じ理由の文言で確認・阻止される。Claude Code と Copilot CLI のどちらのツール名の形でも同じ
2. **Given** ガードの条件を満たした状態、**When** 同じツールを呼ぶ、**Then** 通る
3. **Given** エージェントの Bash に 34 サブコマンドのいずれかの `pecot` 呼び出しがある、**When** 実行しようとする、**Then** 阻止され、対応するツール名が返る
4. **Given** 利用者が端末や `! pecot ...` で呼ぶ、または hooks が内部で CLI を呼ぶ、**When** 実行する、**Then** 阻止されない
5. **Given** hooks の全ファイル、**When** 走査する、**Then** `pecot issue create` などの Bash 文字列で許可・確認を決める判定が 0 件

---

### User Story 4 - 1 回のリリースで切り替え、その後 Python を消す (Priority: P4)

前後比較が全部一致するまでは Python の CLI を配る。一致したら 1 回のリリースで、CLI・MCP サーバ・スキル本文・hooks のガード・Agent Plugins 1.0 の形をそろって切り替える。その後で Python の CLI・テスト・`test-py` レーンを消す。

**Why this priority**: 途中のリリースで、スキルとガードと CLI の組み合わせが食い違った版を利用者に届けない。

**Independent Test**: 切り替えのリリースの前の版は Python の CLI で動く。切り替えの版で、Claude Code と Copilot CLI の両方で quickstart の CUJ が通る。削除の後、Python と pytest の無い環境で pecot-workflow の全レーンが通る。

**Acceptance Scenarios**:

1. **Given** 前後比較が一致していない状態、**When** リリースする、**Then** 利用者に届くのは Python の CLI で、スキル・hooks・manifest は今の形のまま
2. **Given** 切り替えの版、**When** Copilot CLI がプラグインを読む、**Then** root の `mcp.json` から MCP サーバが起動する。`com.github.copilot/` の hooks が働き、旧形式の manifest は無い
3. **Given** Python の削除の後、**When** pecot-workflow のテストを流す、**Then** Python と pytest を使わずに全部通る。CLI の行カバレッジは基準値以上かつ 90% 以上で、下回れば失敗する
4. **Given** `baseline.json` の hooks のテスト件数と起動スクリプトの一覧、**When** 移行後に数える、**Then** どちらも減っていない（消したスクリプトを除く）
5. **Given** 定義書の振る舞いの項目、**When** Python のテストを消した後に定義書の lint を流す、**Then** 全部の項目が Node のテストにつながり、つながるテストの無い項目は 0 件
6. **Given** Python の削除の後、**When** 定義書の一致の確認と、定義書の HTML を作る手順を流す、**Then** どちらも Python の CLI・書き出し・テスト結果を読まずに通る

---

### User Story 5 - プラグイン無しで MCP サーバを npm から使う (Priority: P5)

プラグインを入れていない MCP クライアントの利用者が、npm の `@pecot/workflow-mcp` を 1 エントリ登録するだけで 34 個のツールを使える。

**Why this priority**: pecot-visual / pecot-tools と同じ配布の形にそろえる。プラグインの利用者には影響しないので最後に置く。

**Independent Test**: リリースのタグから `publish-npm.yml` を動かし、出た版を素の MCP クライアントに登録して `project_info` が結果を返す。

**Acceptance Scenarios**:

1. **Given** プラグインの無い MCP クライアント、**When** `npx -y @pecot/workflow-mcp` を登録する、**Then** 34 個のツールが見え、`project_info` が結果を返す
2. **Given** pecot-workflow のリリースのタグ、**When** `publish-npm.yml` を実行する、**Then** その版の `@pecot/workflow-mcp` が npm に出る
3. **Given** 単体配布の README、**When** 読む、**Then** hooks のガードが無く、投稿の確認は MCP クライアント自身に任せることが書いてある

---

### Edge Cases

- 単体配布には hooks が無い。`issue_create` などへの確認は動かず、MCP クライアント自身の確認だけになる
- MCP サーバが起動しない（Node が無い、ミラーの作成に失敗する）ときは、理由を返して止まる。Python や Bash の CLI に切り替えて続けない
- `gh` の認証切れ・GitHub API の失敗は、今の CLI と同じ文言と終了コードで返す
- `release merge` のように時間のかかる操作も、MCP ツールの呼び出しの中で完了まで待つ
- `worktree link` の上書き確認は、CLI では今の対話のまま。MCP では入力で上書きの可否を受け、既定は上書きしない。上書きしなかった対象を一覧で返す
- 切り替えの後、Node の CLI は Python の版がデータ置き場とリポの `.pecot/` に残した状態をそのまま読む
- 前後比較の差し替え口（GitHub API の接続先）は、ループバックの宛先だけを受け付ける。他の値なら起動時に失敗する
- golden と Node の出力が食い違ったら Node 側を直す。Node に合わせて golden を書き換えない
- 移行の途中に Python の CLI か依存が変わり、出力が golden とずれる。そのときは同じ PR で Node を直し、該当の golden を記録し直す
- 移行の途中に Python のコマンドの引数が変わると、定義書が書き出し直される。そのコマンドが Node に移っていれば、同じ PR で Node のコマンド定義も直す。直さないと定義書との比較が失敗する
- 定義書の `generated.json` は 1 ファイルで、移行の途中は Python が書き出す。Node の書き出しで先に書き換えると、まだ移していないコマンドの項目が消える。切り替えの変更まで、Node は比べるだけで書き込まない
- 前後比較のシナリオがある振る舞いを通っていても、その項目につながるテストには数えない。項目ごとに、その振る舞いだけを確かめる Node のテストのケースを置く
- 振る舞いの項目につながる pytest を、Node 側に同じ ID のテストが無いまま消すと、定義書の lint が止まる。つなぎ先を移してから消す

## Requirements *(mandatory)*

### Functional Requirements

| ID | 内容 |
|---|---|
| FR-001 | pecot-workflow の CLI は Node で動く。コマンド・引数・出力・終了コードは移行前と同じ |
| FR-002 | 利用者は pecot-workflow のために Python と uv を入れない。導入は pecot-visual / pecot-tools と同じく、データ置き場に実行用ミラーを作る方式にする |
| FR-003 | pecot-workflow は MCP の stdio サーバを持つ。データ置き場は、起動時にクライアントが渡す `CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA`、無ければ既定の場所の順で解決する。MCP の登録には `env` を書かない |
| FR-004 | MCP ツールは CLI の全 34 サブコマンドを 1 対 1 で写す。スキルが使わない初期設定のコマンドも含む。ツール名は `<group>_<subcommand>`、グループの無いものはコマンド名の `-` を `_` にしたもの。許可の単位はツール 1 つ。CLI と MCP は 1 つのコマンド定義の一覧から作り、片方だけの追加を起こさない |
| FR-005 | スキル本文・エージェント定義・hooks テンプレートは MCP ツールを呼ぶ。Bash で `pecot` を呼ぶ記述を持たない |
| FR-006 | hooks のガードは、許可・確認・阻止を MCP ツールの呼び出しに対して行う。条件と理由の文言は移行前と同じ。Claude Code と Copilot CLI の 2 つのツール名の形を同じに扱う |
| FR-007 | 済んでいる前後比較（シナリオと golden の全件。2026-11-11 の時点で 228 件）を Node の CLI の直接起動と MCP 経由の両方に流し、全部一致させる。golden を記録し直すのは、Python の CLI か依存を変える PR だけ。その PR で Node も同じように直す。Python を消した後は回帰テストとして残す |
| FR-008 | `baseline.json` の基準値は書き換えない。移行後の CLI の行カバレッジは基準値以上かつ 90% 以上とし、下回ればテストを失敗させる。hooks はカバレッジを計らず、テストの件数と起動スクリプトの一覧を基準より減らさない |
| FR-009 | 移行の完了時に、pecot-workflow に Python の CLI とテスト、pytest、`test-py` レーン、uv で venv を作る wrapper、nx の globals にある uv と Python の参照が残らない |
| FR-010 | スキルのテストは、スキル本文にある MCP ツール名がサーバの公開するツール一覧にあるかを確かめ、無ければ失敗する |
| FR-011 | Issue・PR の本文への textlint は扱わない |
| FR-012 | エージェントが Bash で `pecot` を呼ぶと、PreToolUse で全部阻止し、対応する MCP ツール名を返す。Bash の入力で見るのは `pecot` の起動かどうかだけで、サブコマンド別の許可・阻止は持たない。利用者の端末・`! pecot ...`・hooks の内部からの呼び出しは阻止しない |
| FR-013 | hooks の本体は shell と jq のまま。テストは pytest を使わず、Node のテストから shell を起動する形に移す |
| FR-014 | 前後比較が全部一致するまで、リリースで配る CLI は Python のまま。一致したら 1 回のリリースで、CLI・MCP サーバ・スキル本文・hooks のガード・Agent Plugins 1.0 の形・定義書の書き出しの元をそろえて切り替える。Python の削除は切り替えの後に行う。切り替え前のフェーズは配布物の振る舞いを変えない |
| FR-015 | MCP サーバを npm の `@pecot/workflow-mcp` として単体で配る。pecot-visual / pecot-tools と同じく、リリースのタグから `publish-npm.yml` の trusted publishing で出し、リリースのたびに更新する。README に hooks のガードが無いことを書く |
| FR-016 | pecot-workflow は pecot-visual と同じ Agent Plugins 1.0 の形を持つ。root に `plugin.json` と `mcp.json` を置き、Copilot CLI 向けの hooks と agents は `com.github.copilot/` に置く。旧形式 `.github/plugin/plugin.json` と `hooks/hooks-copilot.json` は残さない。Claude Code 向けの従来形式との name・version・MCP サーバの一致をテストで確かめる。切り替えのリリースで出す |
| FR-017 | 旧の sub-issue #17〜#27 は、2026-11-05 に not planned で close した。後継の Issue は、着手のときにこの spec の tasks から w-issueize で作る。2026-11-11 に作り直した tasks を使う |
| FR-018 | 切り替えまで、pecot-workflow の Python の依存（`cli/` の uv）は dependabot の版の更新の対象から外し、今の版のまま止める。脆弱性の alert が出た依存だけを手で上げ、同じ PR で golden を記録し直して Node を追従させる。Python の削除で uv のエントリも消す |
| FR-019 | 移行の前後で公開面が同じことを、定義書（`plugins/pecot-workflow/interface/`）で確かめる。Node のコマンド定義から書き出した項目を、定義書の同じ ID の項目と比べ、入力と CLI の形の差を 0 件にする。比べるのは Node に登録したコマンドだけで、差があれば失敗する。比べ方は定義書のライブラリ（`libs/interface-spec`）のものを使い、別に作らない |
| FR-020 | 切り替えのリリースまで、定義書の書き出しの元は Python のままにする。Node の書き出しは比べるだけで、`generated.json` を書き換えない。34 コマンドがそろっていても同じ。切り替えの変更（FR-014）で書き出しの元を Node に替え、Python の書き出しとそのテストを消す。替えた後の定義書は、項目ごとに MCP ツールの欄を持つ |
| FR-021 | MCP ツールの一覧と入力は、定義書の項目と一致する。定義書の一致の確認（`lint-defs`）が、CLI と MCP の両方を同じ定義書と比べる。`contracts/mcp-tools.md` は定義書に従う |
| FR-022 | 定義書の振る舞いの項目のつなぎ先を、Python のテストから Node のテストへ移す。コマンドを Node に移すフェーズは、そのコマンドの項目が全部 Node のテストにつながることを完了の条件にする。Python を消すまでは両方につながり、消す時点で全部の項目が Node のテストにつながっている。つなぐ先は、今の pytest のケースと同じことを確かめる Node の単体のテストのケースに限り、前後比較のシナリオにはつながない。項目の ID と文は変えない |
| FR-023 | 定義書の仕組みが pecot-workflow について読む先（実装のソース、lint の入力、テスト結果）を、Node の構成に替える。Python の削除の後に、Python の CLI を指す参照が残らない |
| FR-024 | Node の CLI は、Python と同じ共通の出力の関数を通して出力する。コマンドが標準出力・標準エラーへ直接書かないことを、今の lint のまま確かめる |

### Key Entities

| 名前 | 内容 |
|---|---|
| コマンド定義 | サブコマンド 1 つの名前・入力・実行。CLI と MCP ツールの両方がこれから作られる。34 個 |
| MCP ツール | コマンド定義 1 つを写したもの。結果の本文は CLI の標準出力と同じ |
| データ置き場 | `CLAUDE_PLUGIN_DATA` / `PLUGIN_DATA`、無ければ既定の場所。実行用ミラーと状態ファイルを置く |
| 前後比較のシナリオと golden | 済み。2026-11-11 の時点で 228 件。Python の実出力から作った期待値 |
| 定義書 | `plugins/pecot-workflow/interface/`。実装から書き出す `generated.json`（コマンド名・入力・CLI の形・MCP ツール）と、人が書く `authored.yaml`（説明・副作用・終了コード・振る舞いの項目）。項目は 34 個で、ID は `PW-…` |
| 振る舞いの項目 | 定義書の項目が持つ、振る舞いの 1 文と ID。テストが ID を書いてつながる。746 個 |
| 基準値 | 済み。CLI の行カバレッジ 91.0%、hooks のテスト 1,569 件と起動スクリプトの一覧 |
| 単体配布 | npm の `@pecot/workflow-mcp`。hooks を含まない |

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | 内容 |
|---|---|
| SC-001 | Python と uv の無い端末で、quickstart の CUJ が Claude Code と GitHub Copilot CLI の両方で全部通る |
| SC-002 | GitHub Copilot CLI でスキルを実行し、データ置き場が解決されず止まる件数が 0 |
| SC-003 | スキル・agents・hooks テンプレートの、Bash で `pecot` を呼ぶ記述が 201 箇所から 0 になる |
| SC-004 | 前後比較の全件（228 件以上）が、CLI の直接起動と MCP 経由の両方で全部一致する |
| SC-005 | 移行後の CLI の行カバレッジが 91.0% 以上。hooks のテストが 1,569 件以上で、起動スクリプトの一覧が基準を全部含む |
| SC-006 | pecot-workflow に Python の CLI・テスト・`test-py` レーンが残らない |
| SC-007 | Epic #41 の GAP のうち「pecot-workflow の manifest」と「pecot-workflow の準拠範囲」が解消する |
| SC-008 | プラグインを入れていない MCP クライアントで、npm の 1 エントリの登録だけで 34 個のツールが使える |
| SC-009 | `project info` の起動から結果までを 5 回ずつ計り、Node の中央値が Python の中央値以下 |
| SC-010 | Node のコマンド定義から書き出した 34 項目と定義書の、入力と CLI の形の差が 0 件。書き出しの元を Node に替えた差分に、入力と CLI の形の変更が無い |
| SC-011 | Python のテストを消した後、定義書の振る舞いの項目のうち、テストにつながらないものが 0 件。項目の数は移行の前より減らない |

## Assumptions

- 実装先は `plugins/pecot-workflow/`。nx の project 名 `pecot-workflow` と marketplace の `pecot-w` は変えない
- 言語・構成・テストの仕組みは pecot-tools に合わせる。移行中の Node の CLI は `cli-node/` に置き、Python を消すフェーズで `cli/` に移す
- CLI は MCP サーバと並べて残す。hooks と利用者の端末から呼ぶため
- 旧 spec 015 の research・contracts（ツール名の形、ガードの移し方、前後比較の形式）は、名前を読み替えて plan で引き継ぐ。Copilot CLI でのツール名の形は、MCP サーバを作るフェーズに実物を使って確かめる
- npm の `@pecot` スコープと trusted publishing の設定は Epic #44 で用意済み。`@pecot/workflow-mcp` の初回の publish に要る npm 側の設定は利用者が行う
- 定義書の形式・比べ方・lint（spec 022、Epic #199）は済んでいて、この spec では変えない。足りない機能があれば、定義書のライブラリの側に足す
- 34 個は 2026-11-11 の定義書の項目数。移行の途中で Python のコマンドが増えたら、定義書の項目も増える。そのときは Node にも同じコマンドを足す
- CHANGELOG は version-plans からの自動生成に委ねる。各フェーズの PR に pecot-workflow の version plan を付ける
