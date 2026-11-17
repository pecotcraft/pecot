---

description: "main に入れる前の変更を、このリポを乱さずに確かめる試験環境を、設計して作る のタスク一覧"
---

# Tasks: main に入れる前の変更を、このリポを乱さずに確かめる試験環境を、設計して作る

**Input**: `specs/026-pre-merge-test-env/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 3 つの文書

**Tests**: 憲法 II（TDD）を守る。スクリプトは、契約の表の場合ごとに、先にテストを書いて落とし、失敗を確かめてから実装する。配布物の文の変更は、既存の同期のテストに期待を足してから直す。その後に、quickstart.md の手順を検証用で流す。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの順は、plan.md の「実装の順」と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US6） |

T048 から後の番号は、analyze の後に足したタスクだ。進める順は、番号ではなく並びに従う。

パスはリポ root 起点で書く。次の略し方を使う。

| 略 | 指す場所 |
|---|---|
| `p-w/` | `plugins/pecot-workflow/` |
| `spec/` | `specs/026-pre-merge-test-env/` |
| 検証用の clone | `.pecot/work/<Issue番号>/pecot-sandbox/` |

## 全フェーズに共通の完了条件

- 確かめは、検証用（`pecotcraft/pecot-sandbox` とボード `pecot sandbox`）で流す。このリポの Issue・PR・ボードを、確かめの書き込む先にしない
- 配布物を直す PR には、`.nx/version-plans/` に version plan を 1 つ足す。要るかどうかは、pre-push の hook が知らせる
- 文面の規則と lint は、pre-commit で通す。`--no-verify` を使わない
- 実機で確かめた結果は、確かめた版と日付を付けて書く
- 見込みと違う結果が出たら、後のフェーズのタスクを直してから進む。標準から外れる点は、その場でユーザーに伝える

---

## Phase 1: 設計を左右する点を、実機で先に確かめる

**Goal**: research.md の R11-1〜4 と R11-7 に、結果と確かめた日が付いている。見込みと違った点は、後のフェーズを直してある

**Independent Test**: `spec/research.md` の R11 の表の R11-1〜4 と R11-7 の行に、結果・版・日付が書かれている

- [x] T001 [P] #454 で `/reload-plugins` の後に古い版が動いた訳を調べる。w-help の本文に 1 行足し、`--plugin-dir` の 3 つの始め方で、再読み込みの前と後の中身を比べる。始め方は、base で相対パス・worktree で相対パス・絶対パスだ。結果を `spec/research.md` の R11-1 に書く
  - base を書き換えないため、「base で相対パス」は「worktree から base の絶対パスを渡す形」で代えた（R11-1）
- [x] T002 [P] `copilot --plugin-dir <作業ツリー>/plugins/pecot-workflow` で始め、スキル・フック・エージェント・MCP サーバが読まれるかを確かめる。同じ名前の入れてある版との優先も見る。`/env` と `copilot plugin list --json` の出力と結果を `spec/research.md` の R11-2 に書く
- [x] T003 [P] `pecotcraft/pecot-sandbox` の `.github/workflows/ci.yml` を読む。`ci-result`・`version-plan` の名前のチェックを出すか、`merge_group` の契機で動くかを確かめる。結果を `spec/research.md` の R11-3 に書く
- [x] T004 [P] `p-w/cli/templates/workflow/pecot-board-sync.yml` を読み、workflow の中で動く pecot をどこから取るかを確かめる。直した中身で動かす手段（取る先の指定など）があるかを見る。結果を `spec/research.md` の R11-4 に書く
- [x] T048 [P] サブエージェントが、このリポで始めたセッションの中から検証用へ書き込む手段を比べる。MCP ツールの引数、Bash での `pecot`、検証用の clone で起こす `claude -p` の 3 つだ。結果を `spec/research.md` の R11-7 に書く
- [x] T008 T001〜T004 と T048 の結果で見込みと違った点を、`spec/research.md` の各 R の「残る点」と、後のフェーズのタスクに反映する

---

## Phase 2: GitHub に書き込む変更を、検証用で最後まで動かして確かめる (US1、P1)

**Goal**: 検証用が、このリポと同じ決まりで動く。設定のずれを比べられ、確かめで作ったものを片付けられる

**Independent Test**: quickstart.md の 1・2・4・5 が通る。GitHub に書き込む処理を検証用で最後まで動かし、このリポの Issue・PR・ボードに何も増えていない

**契約**: contracts/sandbox-scripts.md、data-model.md の「そろえる設定」「確かめで作ったもの」

**前提**: Phase 1（T003 の結果）

### Tests for User Story 1

- [x] T009 [P] [US1] `.githooks/tests/test_sandbox_diff.py` を足す。偽の `gh` を PATH に置き、contracts/sandbox-scripts.md の `sandbox-diff.sh` の 8 つの場合を、出力の行と終了コードで比べる。実装の前は失敗することを確かめる
- [x] T010 [P] [US1] `.githooks/tests/test_sandbox_sweep.py` を足す。偽の `gh` を PATH に置く。contracts/sandbox-scripts.md の `sandbox-sweep.sh` の 6 つの場合を、出力の行・終了コード・`gh` の呼び出しの記録で比べる。実装の前は失敗することを確かめる

### Implementation for User Story 1

- [x] T011 [P] [US1] `.githooks/scripts/sandbox-diff-items.json` を足す。spec.md の FR-001〜003 を `compare: true`、FR-004〜008 を `compare: false` と `reason` 付きで書く。項目の形は data-model.md の「そろえる設定」に従う
- [x] T012 [US1] `.githooks/scripts/sandbox-diff.sh` を足す。`gh api` で 2 つのリポのマージ方式・ruleset・ボードの項目と値・自動化の有無を読み、`ignore` のキーを読み飛ばして比べる。読み方と終了コード（0・1・2）は contracts/sandbox-scripts.md に従う。T009 を通す
- [x] T013 [US1] `.githooks/scripts/sandbox-sweep.sh` を足す。data-model.md の名前の形に合うブランチと開いた PR・Issue を検証用から片付け、カードをアーカイブする。引数と決まりは contracts/sandbox-scripts.md に従う。T010 を通す
  - Issue の題は `[Task] [cuj …] …` の形になるので、`[cuj …]` を題の先頭ではなく題の中から探す（R4・R11-7）
  - R6 の tgz を添えた検証用のリリースと、タグ `cuj/<Issue番号>-<乱数>-tgz` も消す。contracts/sandbox-scripts.md の対象と、T010 のテストの場合に足す
- [x] T014 [US1] `.githooks/README.md` の、スクリプトの一覧に 2 本を足す。nx の入力の宣言（`.githooks` の project の設定）に、足したファイルが入っているかを確かめ、足りなければ足す
- [x] T015 [US1] T003 の結果で、検証用の `ci.yml` が必須のチェックを出していないと分かったときに行う。検証用のリポの `ci.yml` を、`ci-result`・`version-plan` の名前のチェックを出す形に直す。`pull_request` と `merge_group` の契機で動かす。直しは、検証用の PR と merge queue を通す
  - T003 の結果、必須のチェックを出し、`merge_group` でも動くと分かった（R11-3）。直すものは無いので、#474 の PR で `[x]` にした
- [x] T016 [US1] `.githooks/scripts/sandbox-diff.sh` を実物で動かす。出たずれは 1 件ずつ、検証用を直すか、`sandbox-diff-items.json` で比べない項目にするかを決める。比べない項目にするときは、ユーザーの承認を得て、spec.md の「同じにしなくてよいもの」の表にも足す。「ずれは 0 件」になるまで続ける
- [x] T017 [US1] `p-w/CONTRIBUTING.md` に「試験環境」の節を足す。書くのは、試験環境の一覧・検証用の clone の作り方・確かめの前の `sandbox-diff.sh`・作るものの名前の形・`sandbox-sweep.sh` での片付けの 5 つ
- [x] T049 [US1] pecot-workflow の、GitHub に書き込む処理の一覧を作る。MCP ツールと CLI のコマンドを、定義書（`p-w/interface/`）から漏れなく拾う。利用者へ配るリリースの処理も含める。一覧を、T017 の節に表で書く
- [x] T050 [US1] 同じ節に 3 つを書く。検証用の clone に置く `.pecot/config/.env` の作り方。書き込む前に `board_show` で書き込む先を見ること。このリポの決まりを変えるときは、検証用を先に変えること
- [x] T018 [US1] quickstart.md の 2・4・5 を検証用で流す。失敗する場合（CI が落ちる PR が queue から外される）も流す。結果を PR の説明に書く。このリポの Issue・PR・ボードに何も増えていないことを、流す前と後の件数で比べる
- [x] T051 [US1] T049 の一覧の処理を、1 つずつ検証用で最後まで流す。流せない処理は、訳を一覧に書く。2 つのセッションで同時に流し、互いを変えないことを見る。確かめと片付けを 3 回くり返し、残りが 0 件であることを見る

---

## Phase 3: 直した pecot-workflow を、利用者と同じ形で動かして確かめる (US2、P1)

**Goal**: 開発者とエージェントが、文書の手順だけで、直した pecot-workflow を検証用で動かせる。どの中身が動いているかを、動かす前に確かめられる

**Independent Test**: quickstart.md の 3 が、Claude Code と GitHub Copilot CLI の両方で通る

**前提**: Phase 2（T017 で足した節に、手順を書き足す）

- [x] T019 [US2] `p-w/CONTRIBUTING.md` の「試験環境」の節に、Claude Code での手順を書く。中身は quickstart.md の 3 の始め方と、`installPath` での読み込み元の見方、MCP サーバの起こし直しだ。T001 で分かった訳と、避け方の 1 行も書く
  - 避け方は、直した作業ツリーの絶対パスを `--plugin-dir` に渡し、スキルの本文の直しは `/reload-plugins` の後に確かめることだ（R11-1）
- [x] T020 [US2] 同じ節に、GitHub Copilot CLI での手順を書く。`copilot --plugin-dir <作業ツリーの絶対パス>/plugins/pecot-workflow` で始め、`/env` で読み込み元を見る
  - T002 で、4 種とも読まれると分かった（R11-2）。同じ名前の版を入れていると、フックが両方の版で登録されて動くので、`COPILOT_PLUGIN_DIR_ONLY=true` を付けて `--plugin-dir` の版だけを読ませる手順を書く
- [x] T021 [US2] `CLAUDE.md` に 2 つを足す。検証用の場所（`pecotcraft/pecot-sandbox` とボード `pecot sandbox`）と、`p-w/CONTRIBUTING.md` の「試験環境」の節への案内だ。足すのは 3 行までにする
- [x] T052 [US2] pecot-workflow のスキル・フック・MCP ツール・エージェントの一覧を作る。2 つのクライアントで、全件が作業ツリーから読み込まれることを確かめる。読み込まれないものは、訳とともに同じ節に書く
  - GitHub Copilot CLI で同じ名前の版を入れているとき、エージェントがどちらの版で動くかを、エージェントの本文に目印を足して見る（R11-2）
- [x] T022 [US2] quickstart.md の 3 を、Claude Code と GitHub Copilot CLI のそれぞれで流す。スキル・フック・MCP ツール・エージェントの 4 つを、1 つずつ直して確かめる。文書を読み始めてから、直した中身で動かし始めるまでの時間を測り、5 分以内であることを見る。結果を PR の説明に書く

---

## Phase 4: 利用者へ配る自動化を、検証用で実際に起こして確かめる (US3、P2)

**Goal**: 直した `pecot-board-sync.yml` を、main へ入れる前に検証用で起こし、結果を検証用のボードで見られる

**Independent Test**: quickstart.md の 6 が通る

**前提**: Phase 3（直した中身で動かす手順を使い、同じ節に書き足す）

- [ ] T023 [US3] `p-w/CONTRIBUTING.md` の「試験環境」の節に、配る自動化の手順（quickstart.md の 6）を書く。workflow の中の pecot を直した中身にする手段も書く
  - T004 で、テンプレートは公開したパッケージを取ると分かった（R11-4）。手段は R6 のとおりだ
  - `plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh --dry-run --out-dir=<空のディレクトリ>` で配布ツリーを作る
  - そのディレクトリで `npm pack` を打って tgz を作り、検証用のリリースに添える。検証用の写しでは、`npx` に渡す名前をその URL に替える
  - `npx` が URL から取れることを、検証用で動かして確かめる
- [ ] T053 [US3] 同じ節に 2 つを書く。配る自動化の確かめは、1 度に 1 人が行うこと。確かめの後に、検証用の workflow をこのリポの main のテンプレートへ戻し、`sandbox-diff.sh` で 0 件を見ること
- [ ] T024 [US3] 同じ節に、このリポだけの運用（リリース、依存の更新と脆弱性の通知、workflow を外から起こす仕組み）の扱いを書く。確かめる場所は無いこと、今の確かめ方、場所を作る条件（プラグインのほかにも配るようになったとき）を書く
- [ ] T025 [US3] 検証用の workflow に定期の起動（`schedule`）が無いことと、このリポの Scheduler が検証用を向いていないことを確かめる。確かめた結果を、同じ節に 1 行で書く
- [ ] T026 [US3] quickstart.md の 6 を検証用で流す。1 時間おいて、検証用の実行の一覧に定期の起動が増えていないことを見る。このリポの workflow の実行の一覧とボードが変わっていないことを見る。結果を PR の説明に書く

---

## Phase 5: どこで確かめるかを計画が示し、確かめがこのリポで流れない (US4、P2)

**Goal**: 計画の CUJ に「流す先」がある。w-e2e-planner は、流す先が検証用の CUJ を実投稿まで行う。w-reviewer は、流す先の欠けを挙げる

**Independent Test**: quickstart.md の 7 が通る

**契約**: contracts/cuj-destination.md

**前提**: Phase 3（流す先に書く検証用の場所が `CLAUDE.md` にあり、検証用で動かす手順がある）

### Tests for User Story 4

- [ ] T027 [P] [US4] `p-w/cli/tests/skills/template-rules.test.ts` に期待を足す。plan テンプレの CUJ の例と雛形が「流す先」の行を持つ、という期待だ。実装の前は失敗することを確かめる
- [ ] T028 [P] [US4] `p-w/cli/tests/hooks/cuj-definition-single-source.test.ts` に期待を足す。「流す先」の決まりの文が、plan テンプレ・w-e2e-planner・w-reviewer の 3 か所で同じ、という期待だ。実装の前は失敗することを確かめる

### Implementation for User Story 4

- [ ] T029 [US4] `p-w/cli/templates/comment/plan.md` の CUJ に「流す先」を足す。並びは、誰が・起点・流す先・テスト手順・合格基準にする。CUJ の説明に、contracts/cuj-destination.md の書き方の決まり（3 つの場合）を足す。例の 3 つの CUJ に「流す先 — 手元」を足す。T027 を通す
- [ ] T030 [US4] `p-w/agents/w-e2e-planner.md` を直す。流す先が検証用の CUJ は、検証用の clone を作業ディレクトリにして実投稿まで行う。流す先が検証用でない CUJ は、今のとおり外へ出ない入力まで実行し、実投稿を main に委ねる。結果に、できたものの URL を載せる。CUJ の定義の文に、T029 と同じ決まりの文を足す
  - T048 の結果（R11-7）で、手段は Bash での `pecot` と、同じ clone で起こす `claude -p`（`--allowedTools=<ツール>` の形）に決まった
  - MCP ツールに `repo` を渡す形は止まるので使わない。clone の後に `pecot project activate` を打つことも書く
  - w-e2e-planner.md の「起点が `pecot` の CLI の CUJ: 実行しない」も、流す先が検証用の CUJ では、検証用の clone で打つ形に直す
  - R11-7 は auto mode で確かめた。既定のモードで `claude -p` に許可の設定が要るかを確かめ、要るなら手順に書く
- [ ] T031 [US4] `p-w/agents/w-reviewer.md` の `[cuj]` の視点に、contracts/cuj-destination.md の 2 つの見る点を足す。検証用の場所が無いリポでの扱いも足す。CUJ の定義の文に、T029 と同じ決まりの文を足す。T028 を通す
- [ ] T032 [US4] `p-w/com.github.copilot/agents/` の w-e2e-planner と w-reviewer の写しを、T030・T031 と同じに直す。既存の同期のテストを通す
- [ ] T033 [US4] `CLAUDE.md` に、外へ書き込む CUJ は検証用を流す先にし、このリポを流す先にしない、の 1 行を足す
- [ ] T034 [US4] `.nx/version-plans/` に、pecot-workflow の version plan を足す
- [ ] T035 [US4] quickstart.md の 7 を流す。プロジェクトの指示に検証用が無い場合は、検証用の clone で、指示の無い状態を作って確かめる。結果を PR の説明に書く

---

## Phase 6: 確かめる場所の都合で、作業の順番を待たされない (US6、P3)

**Goal**: フェーズの前後の決まりが、試験環境で確かめられる変更を「積める」とする。プラグインを「マージを待つ」の例にした箇所が無い

**Independent Test**: contracts/prerequisite-rule.md の「確かめ」の 3 つが通る

**契約**: contracts/prerequisite-rule.md

**前提**: Phase 3（決まりが指す試験環境と、その手順が文書にある）

- [ ] T036 [P] [US6] `p-w/skills/w-breakdown/SKILL.md` の Step 7 の引数のコードブロックを直す。種類を決める 2 つの問いを、contracts/prerequisite-rule.md の「直した後」の文にする。「マージを待つ」になる例から「プラグイン」を外し、action・公開したパッケージ・リリース・開発ブランチの CI の例を残す
- [ ] T037 [P] [US6] `p-w/skills/w-help/references/issue-flow-rules.md` の `merge` の説明を直す。問いを T036 と同じ文にし、例から「プラグイン」を外す
- [ ] T038 [P] [US6] `p-w/skills/w-help/references/spec-driven-workflow.md` の「マージを待つ」の説明の行を、T036 と同じ文にする。例の行（action）は残す
- [ ] T039 [P] [US6] `p-w/skills/w-issueize/SKILL.md` を読み、説明の文に試験環境の語が要る箇所を、T036 と同じ文にする。例の行（action）と、表の形・`wait: merge`・`reason` の扱いは変えない
- [ ] T040 [US6] 4 か所の文を読み比べ、問いの文が同じで、「プラグイン」を「マージを待つ」の例にした箇所が無いことを確かめる。GitHub Copilot CLI 向けの写しがあれば、同じに直す
- [ ] T041 [US6] `.nx/version-plans/` に、pecot-workflow の version plan を足す
- [ ] T042 [US6] contracts/prerequisite-rule.md の「確かめ」の 2 つの計画を用意する。作業ツリーの pecot-workflow を読み込んだセッションで、w-breakdown の tasks の工程を動かす。スキルを使う行が「積める」、action を使う行が「マージを待つ」になるのを見る。結果を PR の説明に書く

---

## Phase 7: 人のいないセッションでも、同じ試験環境で確かめる (US5、P3)

**Goal**: 人のいないセッションが、人の操作なしに、検証用で確かめを最後まで流せる。渡す権限は、このリポに書けない

**Independent Test**: quickstart.md の 9 が通る

**前提**: Phase 3（手元で確かめられる手順がある）

最初に、T005・T006 で実機を確かめ、T007 でユーザーが動かし方を選ぶ。T043 から後のタスクは、選んだ動かし方に合わせて直す。

- [ ] T005 [US5] `pecotcraft/pecot-sandbox` にだけ入れた GitHub App の token を使う。ボード `pecot-project`を読めるか・書けるかを確かめる。書き込みは、下書きのカードを 1 枚足して消す形にする。先にユーザーの承認を得る。App はユーザーが作る。結果を `spec/research.md` の R11-5 に書く
- [ ] T006 [US5] クラウドのセッションで、research.md の R11-6 の 5 点を確かめる。`claude` の起動、`CLAUDE_CODE_PLUGIN_DIRS`、付けていないリポへの REST、Projects の REST、自前の環境の GraphQL だ。結果を `spec/research.md` の R11-6 に書く
- [ ] T007 [US5] T006 の結果を、R8 の 3 つの案（Anthropic のクラウド・自前の環境・GitHub Actions）の表に足し、動かし方をユーザーに選んでもらう。選んだ案と訳を `spec/research.md` の R8 と `spec/plan.md` の「標準との対照」に書く。Phase 7 のタスクを、選んだ案に合わせて直す
- [ ] T043 [US5] 検証用のリポだけに入れた GitHub App を、人のいないセッションへ渡す形にする。App の作成・権限の設定・入れる先の設定は、ユーザーに頼む。秘密の値の置き場と渡し方は、T007 で選んだ案の公式の手段を使う。渡し方・期限・取り消し方を、`p-w/CONTRIBUTING.md` の「試験環境」の節に書く
- [ ] T044 [US5] 人のいないセッションが、作業ツリーの pecot-workflow を読み込む手順を、T007 で選んだ案の公式の手段で作る。手順を、同じ節に書く
- [ ] T045 [US5] T005 で、App の token がボード `pecot-project` に書けると分かったときに行う。受け入れる危険として `spec/plan.md` の「標準との対照」に書き、ユーザーの承認を得る。承認が得られないときは、ボードを使う確かめを人のいないセッションの対象から外し、できない範囲として同じ節に書く
- [ ] T046 [US5] 人のいないセッションで、quickstart.md の 4 と同じ確かめを流す。人が 1 度も打たずに終わることを見る。同じ権限で、このリポに Issue を作ろうとして、拒まれることを見る。権限を外して流し、認証の失敗を知らせて止まることを見る。結果を PR の説明に書く
- [ ] T047 [US5] できないと分かった点を、できる範囲とできない範囲に分けて、`p-w/CONTRIBUTING.md` の「試験環境」の節に書く。spec.md の SC-009 を満たせない点が残るときは、ユーザーに伝えて判断を仰ぐ

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | Phase 2 の検証用の整えが、Phase 1 で research.md に書く検証用の `ci.yml` の結果を読む |
| 3 | 2 | 積める | Phase 3 の手順が、Phase 2 で `CONTRIBUTING.md` に足す「試験環境」の節に書き足す |
| 4 | 3 | 積める | Phase 4 の確かめが、Phase 3 で文書に書く、直した中身を読み込む手順を使う |
| 5 | 3 | 積める | Phase 5 の確かめが、Phase 3 で `CLAUDE.md` に書く検証用の場所と、読み込みの手順を使う |
| 6 | 3 | 積める | Phase 6 の決まりの文が、Phase 3 で文書に書く試験環境の手順を指す |
| 7 | 3 | 積める | Phase 7 の人のいないセッションが、Phase 3 で文書に書く手元の手順と同じ確かめを流す |

### User Story Dependencies

| Story | フェーズ | 待つもの |
|---|---|---|
| US1（P1） | 2 | Phase 1 の結果 |
| US2（P1） | 3 | US1 の節 |
| US3（P2） | 4 | US2 の手順 |
| US4（P2） | 5 | US2 の手順 |
| US6（P3） | 6 | US2 の手順 |
| US5（P3） | 7 | US2 の手順と、T007 でのユーザーの選択 |

Phase 4・5・6・7 は、Phase 3 の後なら、互いを待たずに進められる。

### Within Each User Story

- テストのタスクを先に書き、落ちることを確かめてから実装する
- 文書のタスクは、確かめのタスクの前に済ませる。確かめは、文書の手順だけを読んで流す
- 各フェーズの最後のタスクが、検証用での確かめだ

一部のタスクだけが待つ依存は、次のとおり。

| タスク | 待つもの |
|---|---|
| T015 | T003 の結果。必須のチェックが出ていれば、何もしない |
| T019 | T001 の結果 |
| T020 | T002 の結果 |
| T023 | T004 の結果 |
| T043〜T047 | T007 でのユーザーの選択 |
| T030 | T048 の結果 |
| T045 | T005 の結果 |

### Parallel Opportunities

- Phase 1 の T001〜T004 は、別々の対象を調べるので並べて進められる
- Phase 2 の T009・T010・T011 は、別のファイルなので並べて進められる
- Phase 5 の T027・T028 は、別のテストのファイルなので並べて進められる
- Phase 6 の T036〜T039 は、別のファイルなので並べて進められる

`p-w/CONTRIBUTING.md` の「試験環境」の節は、Phase 2・3・4・7 が書き足す。同じ節を触るので、先に main へ入った変更を取り込んでから書く。

## Parallel Example: User Story 1

```text
T009 .githooks/tests/test_sandbox_diff.py を書く
T010 .githooks/tests/test_sandbox_sweep.py を書く
T011 .githooks/scripts/sandbox-diff-items.json を書く
```

## Implementation Strategy

### MVP First

Phase 1〜3 で、GitHub に書き込む変更と、直した pecot-workflow を、手元から検証用で確かめられる。ここまでで、#454 と同じ場面を、このリポを使わずに確かめられる。

### Incremental Delivery

1. Phase 1 で、実機の結果をそろえる
2. Phase 2・3 で、手元から検証用で確かめられるようにする（MVP）
3. Phase 4 で、配る自動化を足す
4. Phase 5 で、計画が流す先を示すようにする。ここから、確かめがこのリポで流れなくなる
5. Phase 6 で、前後の決まりを直す
6. Phase 7 で、人のいないセッションを足す

## Notes

- Phase 7 は、最初の T006・T007 の結果で、後のタスクの中身が変わる。公式の文書は、Anthropic が動かすクラウドで GitHub の GraphQL が拒まれると書いている
- このリポだけの運用を確かめる場所と、pecot-visual・pecot-tools の手順は作らない（spec.md の「この Epic でしないもの」）
- CLI と MCP ツールのコードは直さない。書き込む先は、作業ディレクトリで決まる。T048 でコードの直しが要ると分かったら、ユーザーに伝えて計画を直す
