---

description: "Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る のタスク一覧"
---

# Tasks: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

**Input**: `specs/023-label-triggered-autofix/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 3 つの文書

**Tests**: 憲法 III（テストファースト）を守る。判定・結果のコメントの数え方・選択肢の追加・雛形は、失敗する入力のテストを先に書き、失敗を確かめてから実装する。期待は、出力の行と、API に渡す値で比べる。モックは HTTP とファイルの境界だけに使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「実装の段階と PR」の段階と同じ。

2026-11-18 に、spec 027 の共通の部分に合わせて作り直した。前の版は、Python の CLI と `pecot auto` の 5 つのコマンドを前提にしていた。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスはリポ root 起点で書く。次の略し方を使う。

| 略 | 指す場所 |
|---|---|
| `p-w/` | `plugins/pecot-workflow/` |
| `spec/` | `specs/023-label-triggered-autofix/` |
| 検証用 | リポ `pecotcraft/pecot-sandbox` と、ボード `pecot sandbox`（spec 026） |

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- w-quick・w-active・w-pr の文と、既存のコマンドの振る舞い・終了コードを変えない
- 新しい出力は、既存の共通の関数を通した英語の行にする。データは stdout、それ以外は stderr に出す
- コマンドを足すフェーズは、次の 3 つを同じ PR で済ませる
  - `p-w/interface/authored.yaml` に項目を書き、`p-w/interface/generated.json` を書き出し直す
  - 振る舞いの項目を確かめるテストに、`verifies` で項目の ID を書く
  - `p-w/skills/w-help/references/commands.md` の表に、足したコマンドの行を足す
- 足したコマンドは、`p-w/cli/src/commands/registry.ts` に登録する。MCP ツールは、そこから出る
- 配布物が変わるフェーズは、version plan を `.nx/version-plans/` に足す。要るかどうかは、pre-push の hook が知らせる
- 各テストのカバレッジの閾値を下げない（憲法 III）
- 外へ書き込む確かめは、検証用で流す。このリポを、確かめの書き込む先にしない（憲法 IX）
- 実機で確かめた結果は、確かめた版と日付を付けて書く
- トークンと secret の値を、テストの fixture・ログ・コメントに書かない
- 見込みと違う結果が出たら、後のフェーズのタスクと contracts を直してから進む。標準から外れる点は、その場でユーザーに伝える

---

## Phase 1: User Story 4 — 待ちの値を自動処理が使えるように、設定と判定をつなぐ (Priority: P2)

既定の Status の待ちの値（`Needs Attention`）・設定の `fields.status`・ボードの説明は、#376 と #404 で実装済みだ。このフェーズは、残る差だけを足す。

**Goal**: 設定ファイルが、既定の Status の In Progress の選択肢の ID を持つ。札を自動処理が書いたかを、既存の列の判定が受け取れる

**Independent Test**: 検証用で `pecot project init` を打つと、設定の `fields.status.options` に `in_progress` が足される。2 回目は何も変えない。自動処理の結果のコメントを持つ Issue の `Needs Attention` を、`board_sync` が Todo に戻さない

- [x] T001 [P] [US4] `p-w/cli/src/domain/tests/` に、設定のキー `status.options.in_progress` の、失敗するテストを書く
  - `project init` が、既定の Status の In Progress の選択肢の ID を、設定に書く
  - `in_progress` の無い設定は、今までどおり読める
- [x] T002 [US4] `p-w/cli/src/commands/project-sync.ts`・`p-w/cli/src/domain/board-move.ts` に、`in_progress` のキーを足す
  - 今あるキー（`needs_attention`・`todo`）は変えない
  - 欄は `spec/data-model.md` の「プロジェクトの設定に足すキー」のとおり
- [x] T003 [P] [US4] `p-w/cli/src/domain/tests/` に、札を自動処理が書いたかの判定の、失敗するテストを書く。Issue に、自動処理の結果のコメントの目印（bot が書いたもの）があれば真になる。決め方は `spec/data-model.md` のとおり
- [x] T004 [US4] T003 の判定を `p-w/cli/src/domain/` に足し、`labelWrittenByAutomation` を `false` に固定している 3 か所に渡す
  - 3 か所は、`p-w/cli/src/commands/board-judgment.ts`・`issue-create.ts`・`issue-dependency.ts` だ
  - 目印を読む処理は `p-w/cli/src/infra/github/` に置く
- [x] T005 [US4] `project init` の定義書を直す。`p-w/interface/authored.yaml` の説明・効果・振る舞いの項目に、`in_progress` を書く。対応するテストに `verifies` を付ける
- [x] T006 [US4] 検証用のボードで `pecot project init` を打ち、設定に `in_progress` が足されたことを確かめる。前後で、カードの既定の Status の値が変わっていないことを確かめる
- [x] T007 [US4] 検証用で通った後に、このリポのボードで `pecot project init` を打つ。`.pecot/config/projects/` の設定の差分をコミットする

**Checkpoint**: 設定ファイルから In Progress の ID を引ける。自動処理が書いた札を、列の判定が戻さない

---

## Phase 2: User Story 1・3 — 判定と結果を CLI が扱う (Priority: P1)

**Goal**: `pecot auto gate`・`start`・`finish` が動き、MCP ツール `auto_gate`・`auto_start`・`auto_finish` としても出る。対象外と上限の判定、結果のコメント、待ちの値、起動ラベルを外すことを、エージェントなしで確かめられる

**Independent Test**: 手元で、イベントの JSON の fixture を `pecot auto gate --dry-run` に渡す。`spec/data-model.md` の表のとおりの `kind` と `proceed` が出る。
検証用の Issue に `pecot auto finish --result question` を打つと、結果のコメントが付き、札が `Needs Attention` になり、起動ラベルが外れる。`pecot auto start` を打つと、札が Todo に戻る

- [x] T008 [P] [US1] `p-w/cli/src/domain/tests/` に、判定の失敗するテストを書く。入力は Issue・コメント・イベントの値だ
  - `spec/data-model.md` の「種類の決まり方」の表の 7 行を、1 行ずつ確かめる
  - 「対象外の条件」の表を、1 行ずつ確かめる。進行の欄は、Backlog・Pending・Blocked・Archived の 4 つを別々に確かめる
  - ボードに無い Issue は、`kind` が `start` で `proceed` が真になる
  - ラベルを付けた人の `permission` が `admin`・`write` でなければ、`proceed` は偽で、何も書かない
  - CI を直した回数は、`result=ci-fix-pushed` の目印を持つコメントの数で数える
  - `workflow_run` で、Issue に同じブランチの `pr-created` の目印が無ければ、`proceed` は偽で、何も書かない
- [x] T009 [P] [US3] `p-w/cli/src/domain/tests/` に、結果の失敗するテストを書く
  - `spec/data-model.md` の「結果」の表の 8 行で、既定の Status を書くか、起動ラベルを外すかを確かめる
  - 目印の行の形は `<!-- pecot-auto: result=<結果> run=<run の ID> attempt=<試行> branch=<ブランチ> -->`
  - 同じ run・同じ試行の目印を持つコメントがあれば、`--ensure` は書かない。目印を探すのは、bot のコメントだけだ
  - `--ensure` は、job が `cancelled` なら `limit` にする。`execution_file` の最後の `result` が `error_max_turns` のときも `limit` にする。それ以外の失敗は `failed` にする
  - 外すラベルの名前は環境変数 `PECOT_AUTO_LABEL` から、目印の run と試行は `GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT` から読む
- [x] T010 [US1] `p-w/cli/src/domain/` に判定と結果のモジュールを作り、T008・T009 のテストを通す。種類と結果の値は `spec/data-model.md` のとおりにする。`domain/review-finish.ts` の目印と結果の決め方を手本にする
- [x] T011 [P] [US3] 結果のコメントのテンプレート `p-w/cli/templates/comment/auto-result.md` を作る
  - 欄は `spec/data-model.md` の「結果のコメント」の表のとおり
  - CLI がテンプレートから本文を作る。`review-stopped.md` を扱う `p-w/cli/src/domain/review-finish.ts` と `p-w/cli/src/commands/review-finish.ts` を手本にする
  - `p-w/cli/tests/skills/template-rules.test.ts` が読むテンプレートの一覧に入ることを確かめる
- [x] T012 [US1] `p-w/cli/src/infra/github/` に、判定と結果が使う読み書きを足す。ラベルを付けた人の権限、結果のコメントの検索、既定の Status の値の書き込み、ラベルの付け外しだ。失敗するテストを先に書く
- [x] T013 [US1] `p-w/cli/src/commands/auto.ts` を作り、`gate` を足す。`p-w/cli/src/commands/registry.ts` に登録する
  - 引数と出力は `spec/contracts/cli-commands.md` の `pecot auto gate` のとおり
  - stdout に JSON を出し、`GITHUB_OUTPUT` があれば同じ値を足す
  - `proceed` が偽で、Issue に知らせる理由があるときは、結果のコメントを書く
  - `proceed` が偽でも、終了は成功にする
  - 雛形の版は比べない
- [x] T014 [US3] `p-w/cli/src/commands/auto.ts` に `start` を足す
  - 出すものは `spec/contracts/cli-commands.md` の `pecot auto start` の表のとおり
  - `answers` は、書いた人の `permission` が `admin`・`write` のコメントに限る。ほかの人のコメントは、数だけを出す
  - 自動処理が書いた `Needs Attention` なら、PR が無ければ Todo に、あれば In Progress に戻す。それ以外の札は書かない
  - 設定に `in_progress` が無いときは、無い名前（In Progress）を出して止まる
  - Issue がボードに無ければ、進行の欄を Ready にして載せる。`board add` と同じ処理を使う
- [x] T015 [US3] `p-w/cli/src/commands/auto.ts` に `finish` を足す
  - 振る舞いは `spec/contracts/cli-commands.md` の `pecot auto finish` の表のとおり
  - `--result` と `--ensure` は、どちらか 1 つを受ける
  - `--ensure` は、job の終わり方と `execution_file` から結果を決める
  - 外すラベルの名前と、目印の run と試行は、環境変数から読む
  - 既定の Status に `Needs Attention` が無いときは、結果のコメントに足りない設定を足し、成功で終わる
  - 起動ラベルが既に外れていても、失敗にしない
  - 進行の欄は書かない
- [x] T016 [US1] 3 つのコマンドの振る舞いのテストを `p-w/cli/tests/interface/` に書く。`review-finish.test.ts` と同じ並びだ。HTTP だけをモックし、渡した値と出力の行を比べる。`--dry-run` で何も書かないことと、設定に `fields.status` が無いときに `pecot project init` を案内して止まることも確かめる
- [x] T017 [US1] 定義書・`commands.md` を、共通の完了条件のとおりに直す。対象は `auto gate`・`auto start`・`auto finish` の 3 つ。MCP ツールの `outputSchema` が定義書と一致することを確かめる
- [x] T018 [US3] 検証用の Issue で、`finish --result question`、`start`、`finish --ensure` を順に打つ。コメント・札・ラベルを画面で確かめ、出た行と画面を PR に貼る
- [x] T019 [US1] `spec/research.md` の R2 の「実装で確かめること」を確かめる。結果を R2 に書き、違えば `spec/contracts/workflow-template.md` の権限の表を直す
  - 先に、検証用の自前の App に、R2 の表の権限を足す。権限の更新の承認は、利用者に頼む
  - 検証用の一時のワークフローで、リポに絞って発行したトークンに `permission-organization-projects: write` を付ける
  - そのトークンで、T018 の `finish` がボードを書けるかを見る
  - `gate` に発行する権限の組で、`gate` が進行の欄・ブランチ・PR を読めるかを見る

**Checkpoint**: 判定と結果の書き込みが、エージェントなしで通る

---

## Phase 3: User Story 1・3 — スキル `w-auto` で、ラベルから PR までの手順を書く (Priority: P1) 🎯 MVP

**Goal**: `/pecot-w:w-auto start <Issue>` と `resume` の手順が、配布するスキルとしてある。人を待つ箇所が無い

**Independent Test**: 検証用の clone で、作業ツリーのプラグインを `--plugin-dir` で渡した Claude Code を起こし、検証用の Issue に `/pecot-w:w-auto start <owner/repo/N>` を打つ。
承認も質問の入力も求められずに、計画のコメント・ブランチ・PR・結果のコメントができる。直し方が決まらない Issue では、PR ができず、質問の結果のコメントが付く

- [x] T020 [US1] `p-w/cli/tests/skills/skill-flow-structure.test.ts` に、w-auto の手順の、失敗するテストを足す
  - `start` の Step の順が、`spec/contracts/skill-flow.md` の表の 1〜11 のとおり
  - `ci-fix` の節は、Phase 5 で足す。このフェーズでは無くてよい
  - 本文に `EnterPlanMode`・`AskUserQuestion` が無い。`--no-verify` は、手順の節に無く、共通の決まりの禁止の文にだけある
  - 止まる手順のすべてに、`auto_finish` の呼び出しがある
- [x] T021 [US1] `p-w/skills/w-auto/SKILL.md` を書く
  - frontmatter は `spec/contracts/skill-flow.md` の「frontmatter」の表のとおり。`allowed-tools` は書かない
  - 「共通の決まり」の 7 つを、手順の前に置く
  - `start` と `resume` の手順を、表の Step の順で書く。手順は MCP ツールの名前で書く
  - ブランチは `session_start` で作る。`base` は渡さない。w-active と同じ規則だ
  - PR の `screenshot` の欄には、無人の実行である理由を書くと指示する
  - スキルの文には、どの MCP ツールを何のために使うかだけを書く。ツールの動作と結果の項目は書かない
- [x] T022 [US3] `p-w/skills/w-auto/SKILL.md` に、小さなタスクの範囲の目安と、質問の書き方を書く（FR-014）。中身は `spec/contracts/skill-flow.md` の 2 つの節のとおり
- [x] T023 [US1] スキルの一覧に w-auto を足す
  - `p-w/skills/w-help/references/skills.md`
  - `p-w/README.md` のスキルの表
  - `p-w/cli/tests/skills/` の、スキルの一覧と名前を読むテストの期待
- [x] T024 [US1] 検証用で、直し方が決まる Issue に `start` を打つ。計画のコメント・PR・結果のコメントを確かめ、PR に貼る
- [x] T025 [US3] 検証用で、直し方が 2 通りある Issue に `start` を打つ。質問の結果のコメントを確かめる。答えを書いて `resume` を打ち、ブランチが 1 本のままであることを確かめる
  - 手元の実行では、結果のコメントの書き手が人のアカウントになる。`auto_start` は bot の結果のコメントだけを区切りに読むので、手元の `resume` には答えが渡らない
  - 答えを読んで同じ質問を繰り返さないことは、bot が結果を書く T036 で確かめる

**Checkpoint**: 手元で打てば、Issue から PR までが人を待たずに進む

---

## Phase 4: User Story 1・2 — ワークフローの雛形を配り、ラベルで起動する (Priority: P1)

**Goal**: `pecot workflow install auto` が雛形を書き出す。検証用で、Issue に起動ラベルを付けると PR ができる。起動者・ツール・ターン・時間・同時実行の制限が、何も変えない状態で有効だ

**Independent Test**: `spec/quickstart.md` の「ラベルから PR まで」と「安全策」の表を、検証用でたどる

**前提**: 複数のボードに入ったリポでの指定は、#640（#660）で形が決まった。変数 `PECOT_AUTO_PROJECT` を、CLI には `--project`、スキルには `project=<名前>` で渡す

- [ ] T026 [P] [US2] `p-w/cli/tests/auto-workflow-template.test.ts` に、雛形の失敗するテストを書く
  - 確かめることは `spec/contracts/workflow-template.md` の「テストで確かめること」の表のとおり
  - `workflow_run` の行は Phase 5 で足す
  - `review-workflow-template.test.ts` を手本にする
- [ ] T027 [P] [US1] `p-w/cli/src/domain/tests/workflow-template.test.ts` に、一覧の `auto` の行の失敗するテストを足す。名前・雛形のファイル・置き先と、App の変数と secret の両方が要る設定であることを確かめる
- [ ] T028 [US1] `p-w/cli/src/domain/workflow-template.ts` の `WORKFLOW_TEMPLATES` に、`auto` の行を足す。欄は `spec/data-model.md` の「雛形の一覧の `auto` の行」のうち、名前・雛形のファイル・置き先・要る変数と secret の 4 つ。残りの 3 つの欄は Phase 6 で足す
- [ ] T029 [US1] 雛形 `p-w/cli/templates/workflow/pecot-auto.yml` を作る。このフェーズでは、契機は `issues: labeled` だけにする
  - 1 行目に版の目印 `# pecot-workflow-template: auto 1` を置く
  - 利用者が変える値は、リポの変数と式の `||` の既定値で読む。先頭の `env` に置かない
  - job `gate` と `run` を、`spec/contracts/workflow-template.md` の表のとおりに書く
  - `gate` の `if` に、変数 `PECOT_AGENT_APP_CLIENT_ID` が空でないことと、起動ラベルの名前の判定を書く
  - トークンの発行の step は、job ごとの表の `permission-*` だけを渡す
  - `run` の同時実行は `group: pecot-auto-<gate の number>` と `cancel-in-progress: false`
  - claude-code-action の入力は、同じ文書の表のとおり。`allowed_non_write_users`・`track_progress`・`anthropic_api_key` は書かない
  - `prompt` には `/pecot-w:w-auto <kind> <issue>` だけを書く。Issue の本文・タイトル・コメントを式で埋め込まない
  - `--allowedTools`・`--disallowedTools` は、同じ文書の「許可するツール」のとおり。`--permission-mode default` を明示する
  - 利用者が足す 2 か所（準備の step、許可の変数）を、`# pecot-auto:<囲み>:begin` と `:end` で囲む
  - CLI は `npx -y --prefix=/ @pecot/workflow-mcp@latest` で打つ。最後の step は `if: always()` で `auto finish --ensure` を呼ぶ
  - 後始末の step は、値を `env` で受けて引用符付きの引数で渡す。`gate`・自動処理・後始末の step の `env` に `PECOT_AUTO_LABEL` を渡す
  - action はすべて SHA で固定し、版をコメントに書く
  - 変数 `PECOT_AUTO_PROJECT` を、`gate`・後始末の step には `--project` で、`prompt` には空でないときだけ `project=<名前>` で渡す
- [ ] T030 [US1] `pecot workflow install auto` と `--check`・`--force` のテストを `p-w/cli/tests/interface/workflow-install.test.ts` に足す。書き出した結果に、このリポ固有の名前が残らないことも確かめる
- [ ] T031 [US1] `workflow install`・`workflow doctor` の定義書を直す。`p-w/interface/authored.yaml` の名前の一覧に `auto` を足し、`generated.json` を書き出し直す
- [ ] T032 [US2] 検証用に導入する
  - 検証用の自前の App の権限は、T019 で足してある
  - `pecot workflow install auto` で `.github/workflows/pecot-auto.yml` を書き出し、dist-tag を `@next` に替える
  - 起動ラベルを作る
- [ ] T033 [US1] `spec/quickstart.md` の「ラベルから PR まで」の表を、検証用の Issue でたどる。結果を PR に貼る
- [ ] T034 [US2] `spec/quickstart.md` の「安全策」の表を、検証用でたどる。結果を PR に貼る
  - 起票・コメント・本文の編集で起動しないことは、保守者のアカウントで確かめる。起動するかは操作の種類で決まる
  - 外部の人の本文に従わないことは、同じ文面の Issue を起票して確かめる
  - 書き込み権限の無い人のラベルは、実物で確かめない。`gate` の判定のテスト（T008）と、action の `src/github/validation/permissions.ts` を読んだ結果を PR に書く
- [ ] T035 [US1] `spec/research.md` の R6 の「実装で確かめること」を確かめる。検証用の一時のワークフローで、`claude_args` に `--include-hook-events` を足して起動する。`Bash` を許した実行を、プラグインの `PreToolUse` の hook が止めないかを記録で見る。結果を R6 に書く
- [ ] T036 [US3] `spec/quickstart.md` の「質問と起動し直し」の表を、検証用でラベルからたどる。Epic・Pending・ボードに無い Issue での `gate` の結果も見る。結果を PR に貼る
- [ ] T037 [US1] `spec/research.md` の、足りない設定を Issue に書く経路の「実装で確かめること」を確かめる。変数が空のときと、App に権限が無いときに、Issue に結果のコメントが付くかを検証用で見る（FR-021）。届かなければ、`gate` のトークンで `setup-missing` を書く経路を足す
- [ ] T038 [US2] 検証用で通った後に、このリポへ導入する。利用者の作業を先に頼む
  - 利用者が、このリポで使う自前の App を用意し、変数 `PECOT_AGENT_APP_CLIENT_ID` と secret `PECOT_AGENT_APP_PRIVATE_KEY` を登録する
  - `pecot workflow install auto` で書き出し、dist-tag を `@next` に替える。写しと雛形の一致を、`.githooks/tests/test_review_workflow_copy.py` と同じ形のテストで確かめる
  - `.claude/rules/github-workflows.md` のワークフローの一覧に足す

**Checkpoint**: 検証用で、起動ラベルを付けると PR ができる。外部のアカウントからは起動しない

---

## Phase 5: User Story 1 — PR の CI が落ちたら、上限の回数まで直す (Priority: P1)

**Goal**: 自動処理が作った PR の CI が落ちると、別の run が起きて同じブランチで直す。CI が通るか、上限に達すると、結果のコメントが付く。人が作った PR では動かない

**Independent Test**: `spec/quickstart.md` の「CI の修正」の表を、検証用でたどる

- [ ] T039 [US1] `p-w/cli/tests/skills/skill-flow-structure.test.ts` に、`ci-fix` の手順の、失敗するテストを足す。Step の順が `spec/contracts/skill-flow.md` の表の 1〜7 のとおりで、本文に force push の指示が無い
- [ ] T040 [US1] `p-w/skills/w-auto/SKILL.md` に、`ci-fix` の手順を書く
  - 落ちたチェックとログは `gh pr checks` と `gh run view --log-failed` で読む
  - 失敗が変更と関係しなければ、直さずに `failed` で終わる
  - ブランチの先頭に人のコミットが載っていれば、上書きせずに `failed` で終わる
  - 回数は数えない。`gate` が数える
- [ ] T041 [US1] 雛形 `p-w/cli/templates/workflow/pecot-auto.yml` に、契機 `workflow_run` の `completed` を足す
  - `workflows` の行を、`# pecot-auto:ci-workflows:begin` と `:end` で囲む。初めの値は仮の名前にする
  - `gate` に、`--event-name workflow_run` と `--max-ci-attempts` を渡す
  - `run` の checkout は、`ci-fix` のとき `gate` の `branch` を使う
  - `allowed_bots` に、発行の step の出力 `app-slug` を渡す。`*` は使わない
  - 版の目印を 2 に上げる
- [ ] T042 [US1] `gate` の `workflow_run` の判定を、実物のイベントの JSON で確かめる。fixture を `p-w/cli/src/domain/tests/` に足す
  - CI が通ったとき、`ci-passed` の結果のコメントを書き、`proceed` は偽
  - 上限に達したとき、`limit` の結果のコメントを書き、札を `Needs Attention` にする。`proceed` は偽
  - fork の PR と、人が作った PR では、何も書かない
  - `spec/research.md` の R3 の「実装で確かめること」（fork の PR で `pull_requests` が空になるか）の結果を、R3 に書く
- [ ] T043 [US1] 雛形のテスト `p-w/cli/tests/auto-workflow-template.test.ts` を直す。契機が 2 つあること、CI の名前が印の囲みの中にあること、`allowed_bots` が `app-slug` の出力を読むことを確かめる
- [ ] T044 [US1] 検証用の `.github/workflows/pecot-auto.yml` を書き出し直す。先に、`pecot workflow install auto --check` が古い雛形で失敗することを確かめる。その後 `--force` で書き出し、消える行が出ることを見て、CI の名前を囲みに書く
- [ ] T045 [US1] `spec/quickstart.md` の「CI の修正」の表を、検証用でたどる。結果を PR に貼る
- [ ] T046 [US1] 検証用で通った後に、このリポの写しを書き出し直す

**Checkpoint**: 起動ラベルを付ける 1 回の操作で、CI の通った PR ができる

---

## Phase 6: User Story 5 — onboarding の流れで導入し、設定を確かめられる (Priority: P3)

**Goal**: 利用者が、w-onboarding の流れで自動処理の導入を選べる。`pecot workflow doctor auto` が、足りない設定を名前で示す。`auto` の導入で、Claude の App を入れる案内が出ない

**Independent Test**: `spec/quickstart.md` の「導入」の表をたどる。自動処理を入れていない試し用のリポで、示された手順だけで導入し、起動ラベルで PR ができる

- [ ] T047 [P] [US5] `p-w/cli/src/domain/tests/workflow-template.test.ts` と `p-w/cli/tests/interface/workflow-doctor.test.ts`・`workflow-install.test.ts` に、一覧の行の 3 つの欄の、失敗するテストを書く
  - `spec/contracts/cli-commands.md` の「`workflow doctor auto` が確かめる項目」の表を、1 行ずつ確かめる
  - 権限が無く読めない項目は `skipped:` で出し、足りないと数えない。App の権限は、いつも `skipped:` で出す
  - `workflow install auto` の後の案内に、Claude の App を入れる行が無い。`workflow doctor auto` に `Claude GitHub App` の項目が無い
  - `review` の案内と項目は、今までどおり出る
- [ ] T048 [US5] `p-w/cli/src/domain/workflow-template.ts` の一覧の行に、確かめの種類・導入の後の案内・Claude の App の項目を出すか、の 3 つの欄を足す。`review` の行には、今の振る舞いと同じ値を入れる
- [ ] T049 [US5] `p-w/cli/src/commands/workflow.ts` の `nextSteps` と `CLAUDE_APP_ITEM` を、一覧の行から読む形に直す
- [ ] T050 [US5] `workflow doctor` に、`auto` の行が足す確かめを足す。読み取りは `p-w/cli/src/infra/` に置く
  - 起動ラベル、設定の `fields.status`、既定の Status の待ちの値を確かめる
  - ボードの既定の自動化は、`workflows` の `enabled` を読む
  - CI の名前は、置かれた雛形の囲みの名前と、`.github/workflows/` の `name` を比べる
  - 何も書かない
- [ ] T051 [US5] `workflow install`・`workflow doctor` の定義書を、共通の完了条件のとおりに直す。`doctor` がボードを読むかは、一覧の行で決まる（`specs/027-auto-revise-on-pr/contracts/cli-commands.md` の「プロジェクトの設定」の行）
- [ ] T052 [US5] `p-w/skills/w-onboarding/SKILL.md` に、自動処理の導入の Step を足す（FR-030・FR-031）
  - 使うかを尋ねる。使わないと答えたら、何も置かずに次へ進む
  - 使うなら、次の順に進める。`project_init`、`workflow_install`、GitHub App の作成、変数と secret の登録、起動ラベルの作成、雛形の囲みへの記入、`workflow_doctor`
  - 雛形の囲みに書くのは、CI の名前・準備の step・テストのコマンドの許可の 3 つだ
  - 起動ラベルは、名前・説明・色をつけて作る。説明は、付けると何が起きるかを 1 文で書く
  - 手順が長くなるので、詳細は `p-w/skills/w-help/references/auto-workflow.md` に置く
- [ ] T053 [US5] `p-w/skills/w-help/references/auto-workflow.md` を書く。`review-workflow.md` と同じ並びにし、共通の決まりは `review-workflow.md` の節を指す
  - GitHub App に要る権限を、最小の範囲で列挙し、それぞれの使い道を書く（FR-019）。中身は `spec/research.md` の R2 の表
  - 操作を頼む手順には、開く画面・押すボタン・入れる値の出どころを書く
  - 保護されたブランチの ruleset があることを、前提として書く（FR-029）
  - 利用者が足す 3 か所（CI の名前、準備の step、テストのコマンドの許可）の書き方
  - 上限の 3 つの変数の変え方
  - ビューで既定の Status の札を隠していると、待ちの値が見えないこと
  - App のインストール先と secret の単位の選び方。使うリポだけに絞る形を勧める
  - user 所有のボードは対象外であること
  - GHES は未確認であること
  - 雛形の更新の手順。`workflow_install` の `check` と `force`
  - App にインストールで与えた権限の確かめ方。`workflow_doctor` は読めないので、GitHub の App の設定画面で見る
  - `review-workflow.md` の「自動処理に共通の決まり」の「拒否するツール」の行に、直す自動処理は `Edit`・`Write` を許すことを書き足す
- [ ] T054 [P] [US5] `p-w/skills/w-help/references/auth-config.md` の「エージェント用の認証」に、自動処理が発行する権限の組を足す。`p-w/skills/w-help/SKILL.md` の参照の表に `auto-workflow.md` を足す
- [ ] T055 [US5] `p-w/cli/tests/auto-workflow-template.test.ts` に、導入の説明に書いた変数・secret の名前が雛形と同じであることのテストを足す
- [ ] T056 [US5] 試し用のリポで、w-onboarding の手順だけをたどって導入する。起動ラベルで PR ができることを確かめる。手順の抜けを直す
  - 始めから最初の起動までの時間を測り、30 分に収まるかを見る（SC-008）
  - リポは `gh repo create` で organization に作る。README と、落ちるテストを 1 つ持つ小さなコードを置く
  - 作る前に、`p-w/CONTRIBUTING.md` の「3. 試験環境」を読む
  - 確かめた後のリポの削除は、利用者の確認を得てから行う

**Checkpoint**: このリポのことを知らない利用者が、手順だけで導入できる

---

## Phase 7: 全ストーリー — 通して確かめ、既定値を直す (Priority: P2)

**Goal**: `spec/quickstart.md` の全部の表が通る。ターン・時間・CI を直す回数の既定値が、試した結果に合っている

**Independent Test**: `spec/quickstart.md` を上から下までたどり、期待と違う行が無い

- [ ] T057 `spec/quickstart.md` の「ボード」の 2 つの表を、検証用でたどる。6 つの時点で、列と札を画面で確かめ、スクリーンショットを残す。設定が足りないときの表もたどる
- [ ] T058 導入の後の試行として、このリポの大きさの違う Issue を 5 件以上、自動処理で進める。CUJ ではなく、実際の利用だ。run ごとに、ターンの数・時間・結果を記録する。記録は `.pecot/work/<Issue番号>/` に置く
- [ ] T059 T058 の記録から、雛形の既定値（80 ターン・30 分・CI の修正 3 回）を直す。直したら、版の目印を上げ、`p-w/skills/w-help/references/auto-workflow.md` の数も合わせる
- [ ] T060 `spec/spec.md` の Success Criteria の SC-001〜SC-011 を、1 つずつ確かめる。確かめた方法と結果を、Epic #315 のコメントに書く
- [ ] T061 [P] `spec/` の文書を、実装の結果に合わせる。`spec/research.md` の「残した判断」の表に結果を書き、`spec/contracts/` の 3 つの文書が定義書とずれていれば直す

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 理由 |
|---|---|---|
| 1 | 無い | — |
| 2 | 1 | `start` と `finish` が、設定の `fields.status` と `Needs Attention` を使う |
| 3 | 2 | スキルが `auto_start`・`auto_finish` を呼ぶ |
| 4 | 2 | 雛形が `auto gate`・`auto finish --ensure` を呼ぶ。#640 の形に合わせた変数 `PECOT_AUTO_PROJECT` を雛形に足す |
| 5 | 3・4 | スキルと雛形の両方に、CI を直す種類を足す |
| 6 | 4・5 | `doctor` が、置かれた雛形と起動ラベルを確かめる。CI の名前の確かめは、Phase 5 が足す囲みを読む |
| 7 | 5・6 | 全部がそろってから通して確かめる |

Phase 4 の T033〜T037 は、Phase 3 のスキルが main に入ってから動かす。action は、既定のブランチのプラグインを入れるからだ。雛形と一覧の行の実装（T026〜T031）は、Phase 3 と並べて進められる。
雛形の `npx` は npm の版を取る。足したコマンドが `@next` に出るのは、Phase 2 が main に入った後だ。

### User Story Dependencies

| ストーリー | 終わるフェーズ | 依存 |
|---|---|---|
| US4（ボード） | 1 と 2。画面の確認は 7 | 無い |
| US3（質問と起動し直し） | 3 | 2 |
| US1（ラベルから PR まで） | 4。CI の修正は 5 | 2・3 |
| US2（安全策） | 4 | 2 |
| US5（導入） | 6 | 4 |

### Parallel Opportunities

- Phase 3 と Phase 4 は、Phase 2 の後に並べて進められる。確認のタスク（T033〜T037）だけが Phase 3 を待つ
- Phase 6 は、Phase 5 の後に進める
- フェーズの中では、`[P]` のタスクを並べて進められる

## Parallel Example

Phase 2 の始めに、次の 3 つを並べて進める。

```text
T008 判定の失敗するテスト（p-w/cli/src/domain/tests/）
T009 結果の失敗するテスト（p-w/cli/src/domain/tests/）
T011 結果のコメントのテンプレート（p-w/cli/templates/comment/auto-result.md）
```

## Implementation Strategy

### MVP

Phase 1〜4 で、起動ラベルから PR までが通る。安全策もここでそろう。この時点で、直し方が明らかな Issue には使える。

### 増やし方

| 順 | 足すもの | 届く価値 |
|---|---|---|
| 1 | Phase 1・2 | 止まった Issue がボードで目に入る。判定と結果が CLI で確かめられる |
| 2 | Phase 3 | 手元で打てば、人を待たずに Issue から PR まで進む |
| 3 | Phase 4 | ラベルを付けるだけで PR ができる。外部から起動されない |
| 4 | Phase 5 | CI の通った PR まで、人が介さない |
| 5 | Phase 6 | このリポの外の利用者が導入できる |
| 6 | Phase 7 | 既定値が、試した結果に合う |

### 人の作業が要るところ

| タスク | 頼むこと |
|---|---|
| T019 | 検証用の自前の App の権限の追加と、権限の更新の承認 |
| T038 | このリポで使う自前の App の用意と、変数と secret の登録 |
| T056 | 確かめた後の、試し用のリポの削除の確認 |
