---

description: "CLI の出力を共通の関数だけが書き、行の形がコマンドによらずそろう のタスク一覧"
---

# Tasks: CLI の出力を共通の関数だけが書き、行の形がコマンドによらずそろう

**Input**: `specs/021-cli-output-functions/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/output-lines.md、quickstart.md

**Tests**: 憲法 II（TDD）を守る。期待の行を先にテストへ書き、失敗を確かめてから実装する。期待の行は [contracts/output-lines.md](contracts/output-lines.md) の形で、具体的な文字列で比べる。モックは書き込み先（stdout・stderr）と偽の GitHub だけに使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「実装の段階と PR」の段階と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスは `plugins/pecot-workflow/` 起点で書く。例は `cli/`・`cli-node/`・`hooks/`・`skills/`。

`plugins/pecot-visual/`・`plugins/pecot-tools/`・`.githooks/`・`.nx/` は、リポ root 起点で書く。

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- 変えたプラグインの version plan を `.nx/version-plans/` に足す。出力の形が変わるので、利用環境のエージェントに見える変更として書く。CHANGELOG は手で編集しない
- 書く文言は英語にする。行の形は contracts/output-lines.md に従う。GitHub に書く Issue・PR の本文とコメントは変えない
- 出力の文字列で判定しているスキル・hooks・テンプレート・テストを `grep` で探し、同じ PR で直す（FR-011）
- Python の出力を変えるフェーズは、同じ PR で該当シナリオの golden を記録し直す（spec 020 の FR-007）。記録は `pnpm -C plugins/pecot-workflow/cli-node run record:parity <id>...` で行う
- テストの後に、変えたコマンドを実物で動かし、出た行を PR に貼る（憲法 II）
  - pecot-workflow は、読むだけのコマンドと `--dry-run` を実ボードで動かす。実ボードに Issue・コメントを作らない
  - pecot-visual・pecot-tools は、MCP クライアントからツールを呼ぶ
- 各テストのカバレッジの閾値を下げない（憲法 III）。閾値は `cli/pyproject.toml` と各 `vitest.config.ts` にある
- 終了コードを変えない
- spec 020 のコマンドを Node に移す作業が並行して進むときは、Node のコマンドも `cli-node/src/commands/output.ts` を使う

---

## Phase 1: 共通の関数 — Python と Node が同じ行を出す (Priority: P2)

**Goal**: Python と Node に共通の関数がそろい、同じ入力で同じ行を出す。コマンドの出力はまだ変えない

**Independent Test**: Python と Node の出力のテストが、`cases.json` の全件で一致する。テストは `cli/tests/cli/test_output.py` と `cli-node/tests/output/output.test.ts`

- [x] T001 [US4] `cli-node/tests/output/cases.json` を作る。contracts/output-lines.md の「期待の行の一覧」の形で、次の要素を全部入れる
  - 7 つの種類それぞれ
  - 動詞の表の全 11 語について、dry-run の有無の両方
  - count の値の `null`（`unknown`）と `0`
  - 複数行の message（2 行目以降に空白 2 つ）と、末尾に改行のある message
  - dry-run のときの error（前置きを変えない）
- [x] T002 [P] [US4] `cli/tests/cli/test_output.py` を書く。`cases.json` を読み、各要素について `Output` の書き込み先を差し替えて、出た行と出先を比べる。この時点で失敗することを確かめる
- [x] T003 [P] [US4] `cli-node/tests/output/output.test.ts` を同じ考えで書き、失敗することを確かめる
- [x] T004 [US4] `cli/commands/_output.py` に `Verb`（列挙型）・`Operation`・`Output` を実装する。data-model.md の型に従う
  - `Output(dry_run)` は `planned`・`done`・`warning`・`error`・`count`・`data` を持つ。note は pecot-workflow では持たない
  - 書き込み先は呼ぶたびに `sys.stdout`・`sys.stderr` から解決する。import の時点で固定すると、typer の `CliRunner` が出力を捕まえられない
  - 「動詞は列挙型で持ち、自由な文字列を受け取らない」を型で守る
- [x] T005 [US4] `cli-node/src/commands/output.ts` に、T004 と同じ型と関数を実装する。書き込み先は引数で受け取る
- [x] T006 [US4] `core/` が `commands/_output.py` を import しないことを確かめる。確かめるのは `cli/tests/unit/test_architecture.py` の層の決まり。決まりに無ければ足す

**Checkpoint**: T002・T003 が通る。golden は変わらない

---

## Phase 2: User Story 1 — Tracker の sync のログが 1 事柄 1 行でそろう (Priority: P1) 🎯 MVP

**Goal**: `security sync`・`dependabot sync` の行が、共通の関数を通った英語の行になる

**Independent Test**: 偽の GitHub で 2 つの sync を dry-run あり・なしで動かし、期待の行と一致する。dry-run なしで `dry-run:` の行と `null`・`None` が 0 行

- [x] T007 [P] [US1] `cli/tests/cli/test_dependabot.py` の期待値を、新しい行に書き換える。次を含める
  - dry-run なしで、Tracker の書き換えが `updated: Tracker #<n> body` の 1 行だけになる
  - dry-run ありで、同じ事柄が `dry-run: would update Tracker #<n> body` になる
  - 検証の結果が未設定の PR を含む件数の行が `count: <label>: <n>` で、`null` を含まない
- [x] T008 [P] [US1] `cli/tests/cli/test_security.py` の期待値を、同じ考えで書き換える
- [x] T009 [US1] `cli/commands/_tracker_sync.py` の出力を `Output` に移し、英語にする
- [x] T010 [US1] `cli/commands/dependabot.py` の `_echo_plan` を消す。各事柄を `Operation` にして、`planned` を実行の前に、`done` を実行の後に呼ぶ。件数の行の名前は英語で渡し、API のフィールド名を使わない
- [x] T011 [US1] `cli/commands/security.py` を同じ形に移す
- [x] T012 [US1] golden の `security-sync-*`・`dependabot-sync-*` を記録し直し、`record:parity:check` で差が 0 件になることを確かめる

**Checkpoint**: quickstart.md の 2 が通る。マージ後、Actions の `security-alerts.yml`・`dependabot-prs.yml` の次の run のログを読み、SC-003 を確かめる

---

## Phase 3: User Story 2 — help の文言を英語にする (Priority: P1)

**Goal**: 全コマンドの docstring と `help=` が英語になる。行の出力は変えない。help を記録した golden を、このフェーズで 1 回だけ記録し直す

**Independent Test**: `cli/tests/unit/test_english_only.py` が通る。`pecot --help` と各グループの `--help` が英語

- [x] T013 [US2] `cli/tests/unit/test_english_only.py` を書く。`cli/commands/` の docstring と `help=` に日本語の文字が無いことを、ast で確かめる。この時点では失敗する
- [x] T014 [US2] `cli/commands/` の全ファイルの docstring と `help=`（118 か所）を英語にする。`main.py`・`options.py` を含める
- [x] T015 [US2] `cli/tests/` で help の文言を期待しているテストを書き換える
- [x] T016 [US2] help を記録している golden を、全部記録し直す。`global-ok-help*`・`global-usage-no-args` のほか、`Options ─` か `Commands ─` を含むものを `grep` で探す

**Checkpoint**: T013 が通り、`record:parity:check` の差が 0 件。これ以降のフェーズは help の golden を触らない

---

## Phase 4: User Story 2 — issue のコマンドをそろえる (Priority: P1)

**Goal**: `issue` の 5 コマンドの出力が、共通の関数を通った英語になる

**Independent Test**: golden の `issue-*` が記録し直した値と一致する。`cli/commands/issue.py` に `typer.echo` が 0 か所

- [ ] T017 [US2] `cli/tests/cli/` の issue のテストの期待値を、新しい行に書き換える。データ（Issue の本文）は stdout、それ以外の行は stderr に出ることを確かめる
- [ ] T018 [US2] `cli/commands/issue.py` の `typer.echo` 141 か所を `Output` に移す。進捗の行は消す（research R4）
- [ ] T019 [US2] golden の `issue-*` を記録し直す。スキル（`skills/*/SKILL.md`）が issue の出力の文言を引いていれば直す

**Checkpoint**: `record:parity:check` の差が 0 件

---

## Phase 5: User Story 2 — pr のコマンドをそろえる (Priority: P1)

**Goal**: `pr` の 4 コマンドの出力が、共通の関数を通った英語になる

**Independent Test**: golden の `pr-*` が記録し直した値と一致する。`cli/commands/pr.py` に `typer.echo` が 0 か所

- [ ] T020 [US2] `cli/tests/cli/` の pr のテストの期待値を、新しい行に書き換える。`pr create --dry-run` の予定の行が `dry-run: would ...` になることを含める
- [ ] T021 [US2] `cli/commands/pr.py` の `typer.echo` 151 か所を `Output` に移す
- [ ] T022 [US2] golden の `pr-*` を記録し直す。スキルと hooks が pr の出力の文言を引いていれば直す

**Checkpoint**: `record:parity:check` の差が 0 件

---

## Phase 6: User Story 2 — project のコマンドをそろえる (Priority: P1)

**Goal**: `project` の 10 コマンドの出力が、共通の関数を通った英語になる。`project info` などが組み立てる見出しと項目名も英語になる

**Independent Test**: golden の `project-*` が記録し直した値と一致する。`cli/commands/project.py` に `typer.echo` が 0 か所

- [ ] T023 [US2] `cli/tests/cli/` と `cli/tests/e2e/` の project のテストの期待値を書き換える。`project info` の表はデータとして stdout に出ることを確かめる
- [ ] T024 [US2] `cli/commands/project.py` の `typer.echo` 141 か所を `Output` に移す
  - `プロジェクト情報を取得中...` などの進捗の行は消す
  - Archived の削除は `deleted: <n> archived items` の結果の行にする
  - CLI が組み立てる見出しと項目名（`基本情報`・`ロードマップリポ`・`登録済みリポジトリ`・`ボード状況` など）を英語にする。GitHub から読んだ値は変えない
- [ ] T025 [US2] golden の `project-*` を記録し直す。`project info` の出力を引くスキルを、新しい英語の見出しと項目名に直す
  - `skills/w-breakdown/SKILL.md` の Step 2（`ロードマップリポ: ...` の行で判定している）
  - `skills/w-repo-add/SKILL.md`（`登録済みリポジトリ` の節を見ている）
  - 他のスキルと hooks の session-start も `grep` で確かめる

**Checkpoint**: `record:parity:check` の差が 0 件

---

## Phase 7: User Story 2 — 残りのコマンドをそろえ、英語の文言をテストで守る (Priority: P1)

**Goal**: `release`・`worktree`・`repo`・`session` と、グループの無いコマンドがそろう。`cli/commands/` に日本語の固定の文言が残らない

**Independent Test**: golden の全 224 件が一致する。`cli/tests/unit/test_english_only.py` が全リテラルで通る。`cli/commands/` の `_output.py` 以外で `typer.echo` が 0 か所

- [ ] T026 [US2] `cli/tests/unit/test_english_only.py` の対象を、`cli/commands/` の全文字列リテラル（f-string の固定部分を含む）に広げる。この時点では失敗する
- [ ] T027 [P] [US2] `cli/commands/release.py`（73 か所）を `Output` に移す。テストの期待値も直す
- [ ] T028 [P] [US2] `cli/commands/worktree.py`（47 か所）を同じ形に移す
- [ ] T029 [P] [US2] repo のコマンドを移す。対象は `cli/commands/repo.py`（47 か所）・`repo_display.py`（3 か所）・`_repo_policy.py`（5 か所）
- [ ] T030 [P] [US2] `cli/commands/session.py`（27 か所）を移す
- [ ] T031 [US2] `cli/commands/main.py`（4 か所）を移す。グループの無いコマンド（`add-to-project`・`create-branch`・`delete-branch`・`update-issue-status`）も含める
- [ ] T032 [US2] 残りの golden を記録し直す。全 224 件で `✔`・`✓` が 0 個になることを確かめる
  - `release-*`・`worktree-*`・`session-*`・`global-ok-show-repo-*`
  - `add-to-*`・`create-branch-*`・`delete-branch-*`・`update-issue-*`
- [ ] T033 [US2] T026 が通ることを確かめる

**Checkpoint**: quickstart.md の 3 が通る

---

## Phase 8: User Story 3 — 直接の出力を lint で止める (Priority: P2)

**Goal**: pecot-workflow の Python と `cli-node/` で、共通の関数の外の直接の出力を lint が止める

**Independent Test**: `cli/commands/issue.py` に `typer.echo("x")` を足すと ruff が `TID251` で止まる。`cli-node/src/cli.ts` に `process.stderr.write("x\n")` を足すと eslint が止まる

- [ ] T034 [US3] `cli/pyproject.toml` の `[tool.ruff.lint]` を直す
  - `select` に `T20` と `TID251` を足す
  - `[tool.ruff.lint.flake8-tidy-imports.banned-api]` に、直接の出力の 6 つを足す。`typer.echo`・`typer.secho`・`click.echo`・`sys.stdout`・`sys.stderr`・`rich.print`
  - banned-api の理由の文言で、`cli/commands/_output.py` を使うよう示す
  - `per-file-ignores` で `commands/_output.py` と `tests/` を外す
- [ ] T035 [US3] T034 で見つかる違反を直す。`cli/core/` などコマンドの外の出力は、`Output` に移すか、呼ぶ側のコマンドへ返す形にする
- [ ] T036 [US3] `cli-node/eslint.config.js` に、直接の出力を止める規則を足す
  - `no-console`
  - `no-restricted-properties` で `process.stdout.write`・`process.stderr.write`
  - `no-restricted-syntax` で、`stdout`・`stderr` という名前のものへの `.write` 呼び出し
  - `src/commands/output.ts` とテストは外す
- [ ] T037 [US3] `cli-node/` の直接の出力を、共通の関数を使うか、呼ぶ側へ返す形に直す。対象は `src/cli.ts`・`src/infra/worktree-links.ts`・`src/infra/github/client.ts`
- [ ] T038 [US3] quickstart.md の 4 を実行し、両方で止まること、`_output.py`・`output.ts` では止まらないことを確かめる

**Checkpoint**: pre-commit が全ファイルで通る

---

## Phase 9: User Story 5 — pecot-visual の診断行をそろえる (Priority: P3)

**Goal**: pecot-visual の stderr の診断行が共通の関数を通り、`error:`・`warning:`・`note:` の英語の行になる

**Independent Test**: PNG の生成に失敗する入力で、ツールの結果の stderr が `warning:` で始まる。`[warn]`・`[info]`・`pecotv:` が出ない

- [ ] T039 [US5] `plugins/pecot-visual/cli/tests/` の期待値を書き換え、失敗することを確かめる。`[warn]`・`[info]`・`pecotv:` を、`warning:`・`note:`・`error:` にする
- [ ] T040 [US5] `plugins/pecot-visual/cli/tests/diagnostics-cases.json` に、error・warning・note の期待の行を置く。error・warning は、`cli-node/tests/output/cases.json` の該当の要素と同じ値にする
- [ ] T041 [US5] `plugins/pecot-visual/cli/src/diagnostics.ts` に、error・warning・note の関数を実装する。書き込み先は引数で受け取る。T040 の全件と一致することをテストで確かめる
- [ ] T042 [US5] `plugins/pecot-visual/cli/src/` の直接の出力を `diagnostics.ts` に移す
  - `cli.ts`
  - `infra/slidev-to-pptx/server.ts`
  - `infra/slidev-to-pptx/console-logger.ts`
- [ ] T043 [US5] pecot-visual の domain 層で直接書いている箇所を、出力先のインターフェースを受け取る形に直す。今の `Logger` と同じ形にし、実装は infra 層に置く
  - `plugins/pecot-visual/cli/src/domain/slidev-project/generated-files.ts`
  - `plugins/pecot-visual/cli/src/domain/pptx-ooxml/prerender-replace.ts`
- [ ] T044 [US5] `plugins/pecot-visual/cli/eslint.config.js` に、T036 と同じ規則を足す。`src/diagnostics.ts`・`src/mcp/serve.ts` の stdout のガード・テストは外す
- [ ] T045 [US5] MCP サーバとして動かし、stdout に JSON-RPC 以外の行が出ないことを、既存の serve のテストで確かめる

**Checkpoint**: quickstart.md の 5 の pecot-visual の部分が通る

---

## Phase 10: User Story 5 — pecot-visual の MCP ツールの文言を英語にする (Priority: P3)

**Goal**: pecot-visual の MCP ツールが返す結果の `message`・エラーの文言・ツールと引数の説明文が英語になる

**Independent Test**: `plugins/pecot-visual/cli/tests/english-only.test.ts` が通る。ツールの一覧の説明文と、依存が未取得のときの結果の `message` が英語

- [ ] T046 [US5] `plugins/pecot-visual/cli/tests/english-only.test.ts` を書く。`src/` の文字列リテラル（テンプレートリテラルの固定部分を含む）に日本語の文字が無いことを確かめる。この時点では失敗する
- [ ] T047 [P] [US5] `plugins/pecot-visual/cli/src/mcp/tools/` の各ツールの説明文（`description`、35 か所）と引数の説明を英語にする
- [ ] T048 [P] [US5] `plugins/pecot-visual/cli/src/mcp/tools/` の結果の `message` とエラーの文言を英語にする。`_shared.ts` の依存が未取得のときの文言を含める
- [ ] T049 [P] [US5] `plugins/pecot-visual/cli/src/domain/`・`src/infra/` の、エラーとして結果に入る文言を英語にする。例は `cache-store.ts`・`image-dimensions.ts`
- [ ] T050 [US5] `plugins/pecot-visual/cli/tests/` の日本語の文言を期待しているテストを書き換える。`plugins/pecot-visual/skills/*/SKILL.md` がツールの文言を引いていれば直す
- [ ] T051 [US5] T046 が通ることを確かめる

**Checkpoint**: quickstart.md の 5 の MCP の文言の部分が、pecot-visual で通る

---

## Phase 11: User Story 5 — pecot-tools の診断行と MCP ツールの文言をそろえる (Priority: P3)

**Goal**: pecot-tools の診断行が共通の関数を通り、MCP ツールが返す文言と説明文が英語になる。3 つのプラグインの error・warning の行が同じであることを、root のテストで守る

**Independent Test**: Node の版が下限より古いときの起動のエラーが `error:` で始まる。`plugins/pecot-tools/cli/tests/english-only.test.ts` と root のテストが通る

- [ ] T052 [US5] `plugins/pecot-tools/cli/tests/english-only.test.ts` を T046 と同じ考えで書き、失敗することを確かめる。`pecot-tools:` を期待しているテストを `error:` に書き換える
- [ ] T053 [US5] `plugins/pecot-tools/cli/tests/diagnostics-cases.json` を T040 と同じ値で置く。`plugins/pecot-tools/cli/src/diagnostics.ts` に error・warning・note の関数を実装し、全件と一致することをテストで確かめる
- [ ] T054 [US5] `.githooks/tests/test_cli_output_lines_match.py` を書く。3 つの期待の行のファイルで、error・warning・note の要素が同じであることを確かめる
  - `plugins/pecot-workflow/cli-node/tests/output/cases.json`
  - `plugins/pecot-visual/cli/tests/diagnostics-cases.json`
  - `plugins/pecot-tools/cli/tests/diagnostics-cases.json`
- [ ] T055 [US5] `plugins/pecot-tools/cli/src/cli.ts` と `src/mcp/serve.ts` の直接の出力を `diagnostics.ts` に移す。stdout のガードは残す
- [ ] T056 [US5] `plugins/pecot-tools/cli/src/` のツールの説明文・結果の文言・エラーの文言を英語にする（日本語を含むファイル 32）。awscli から読んだ出力は変えない
- [ ] T057 [US5] `plugins/pecot-tools/cli/eslint.config.js` に T036 と同じ規則を足す。`src/diagnostics.ts`・`src/mcp/serve.ts` の stdout のガード・テストは外す
- [ ] T058 [US5] T052・T054 のテストと、`plugins/pecot-tools/cli/tests/integration/real-awscli.test.ts` が通ることを確かめる

**Checkpoint**: quickstart.md の 5 が、pecot-tools でも通る

---

## Phase 12: hooks がエージェントに返すメッセージを英語にする (Priority: P3)

**Goal**: pecot-workflow と pecot-visual の hooks が返すメッセージを英語にする。前置きは CLI と同じ行の種類のものを使う（FR-014）

**Independent Test**: hooks の英語のテストが 2 つとも通る

- `hooks/tests/test_english_only.py`
- `plugins/pecot-visual/hooks/tests/english-only.test.sh`

- [ ] T059 [P] `hooks/tests/test_english_only.py` を書く。`hooks/**/*.sh` と `hooks/hooks*.json` のコメントでない行に、日本語の文字が無いことを確かめる。この時点では失敗する
- [ ] T060 [P] `plugins/pecot-visual/hooks/tests/english-only.test.sh` を同じ考えで書き、失敗することを確かめる
- [ ] T061 `hooks/lib/` の日本語のメッセージ（105 行）を英語にする。拒否の理由は `error:`、注意は `warning:` で始める。`hooks/lib/adapters/claude-adapter.sh` の `フック実行エラー` を含める
- [ ] T062 `plugins/pecot-visual/hooks/lib/` と `hooks.json` の日本語のメッセージ（112 行）を英語にする。`eslint-check.sh`・`validate-references-check.sh`・`layout-conventions.sh` が多い。外部のツール（textlint の規則など）が返す文言は変えない
- [ ] T063 `hooks/tests/` と `plugins/pecot-visual/hooks/tests/` の、日本語のメッセージを期待しているテストを書き換える
- [ ] T064 T059・T060 が通ることを確かめる。spec の SC-001〜SC-007 を quickstart.md の 1〜6 で確かめ、結果を PR に書く

**Checkpoint**: quickstart.md の 6 が通る

---

## Dependencies & Execution Order

### Phase Dependencies

| フェーズ | 始められる時期 |
|---|---|
| 1 | 最初 |
| 2（US1） | 1 の後 |
| 3（US2・help） | 1 の後。2 と並べてよい |
| 4〜7（US2） | 3 の後。同じファイルの docstring と出力の書き換えがぶつからないようにする。4〜7 は互いに独立で、2 とも並べてよい |
| 8（US3） | 2〜7 が全部終わってから |
| 9（US5） | 1 の後ならいつでも |
| 10（US5） | 9 の後。eslint の規則と `diagnostics.ts` を先にそろえる |
| 11（US5） | 9 の後。期待の行を 9 と同じにする |
| 12 | 1 の後ならいつでも |

### User Story Dependencies

| ストーリー | 依存 |
|---|---|
| US4 | 無い。Phase 1 で共通の関数がそろう |
| US1 | US4 の共通の関数に依存する |
| US2 | US4 の共通の関数に依存する。US1 とは独立 |
| US3 | US1・US2 で Python の移行が終わってから lint を有効にする |
| US5 | US4 の契約に依存する。pecot-workflow の移行とは独立 |

### Parallel Opportunities

| 段 | 並べて進められるフェーズ |
|---|---|
| Phase 1 の後 | 2・3・9・12 |
| Phase 3 の後 | 4・5・6・7 |
| Phase 9 の後 | 10・11 |
| Phase 2〜7 の後 | 8 |

## Parallel Example

```text
# Phase 1 の後、次を並べて進められる
Phase 2: T009〜T011 Tracker の sync
Phase 3: T014 docstring と help の英語化
Phase 9: T041〜T043 pecot-visual の診断行
Phase 12: T061 pecot-workflow の hooks / T062 pecot-visual の hooks

# Phase 3 の後、次を並べて進められる
Phase 4: T018 issue.py
Phase 5: T021 pr.py
Phase 6: T024 project.py
Phase 7: T027 release.py / T028 worktree.py / T029 repo.py / T030 session.py
```

golden の記録し直しは、フェーズごとに該当シナリオだけを対象にする。help を記録した golden は Phase 3 だけが触る。並べて進めた PR どうしで、同じ golden のファイルを触らない。

## Implementation Strategy

### MVP

MVP は Phase 1〜2 とする。毎時の Tracker の sync のログが、共通の関数を通った英語の 1 事柄 1 行になる。行の形と契約を、実物の出力に当てて確かめられる。

### 増やし方

1. Phase 1〜2 で、共通の関数と最初の実物がそろう
2. Phase 3 で、help が英語になる
3. Phase 4〜7 で、pecot-workflow の全コマンドが英語の共通の形になる
4. Phase 8 で、直接の出力を lint が止める
5. Phase 9〜11 で、pecot-visual・pecot-tools の診断行と MCP の文言がそろう
6. Phase 12 で、hooks のメッセージが英語になる
