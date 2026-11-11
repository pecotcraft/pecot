---

description: "Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る のタスク一覧"
---

# Tasks: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

**Input**: `specs/023-label-triggered-autofix/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 3 つの文書

**Tests**: 憲法 II（TDD）を守る。判定・結果のコメントの数え方・選択肢の追加は、失敗する入力のテストを先に書き、失敗を確かめてから実装する。期待は、出力の行と、API に渡す値で比べる。モックは HTTP の境界だけに使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「実装の段階と PR」の段階と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスはリポ root 起点で書く。`plugins/pecot-workflow/` は `p-w/` と略す。

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- w-quick・w-active・w-pr の文と、既存のコマンドの振る舞い・終了コードを変えない
- 新しい出力は、既存の共通の関数を通した英語の行にする。データは stdout、それ以外は stderr に出す
- コマンドを足すフェーズは、次の 4 つを同じ PR で済ませる
  - `p-w/scripts/interface/export.py --write` で `p-w/interface/generated.json` を書き出し直す
  - `p-w/interface/authored.yaml` に項目を書く。振る舞いの項目を確かめる pytest に `verifies` を付ける
  - `p-w/skills/w-help/references/commands.md` を生成し直す
  - `p-w/cli-node/tests/parity/` のコマンドのパスと数を直し、ok と ok 以外のシナリオを 1 件ずつ足して golden を記録する
- 環境変数を読む行には、`# interface-env: <名前>` の目印を付ける
- 配布物が変わるフェーズは、version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 各テストのカバレッジの閾値を下げない（憲法 III）
- テストの後に、足したコマンドを実物で動かし、出た行を PR に貼る（憲法 II）
- トークンと secret の値を、テストの fixture・ログ・コメントに書かない

---

## Phase 1: User Story 4 — 既定の Status に待ちの値を足し、ボードの説明を実装に合わせる (Priority: P2)

**Goal**: `pecot project init` が、既定の Status に赤の `Waiting` を足す。設定ファイルが既定の Status の ID を持つ。配布するボードの説明が、進行の欄の 6 つの値と既定の Status を書いている

**Independent Test**: `pecot project init` を 2 回打つ。1 回目で `Waiting` が足され、2 回目は何も足さない。カードに入っていた Todo・In Progress・Done の値が残っている。設定ファイルに `fields.status` がある

- [ ] T001 [P] [US4] `p-w/cli/tests/` に、既定の Status の読み取りと選択肢の追加の、失敗するテストを書く
  - 今の選択肢を `id` つきで全部読み、1 つ足した一覧を `updateProjectV2Field` に渡す
  - 渡す一覧の既存の選択肢が、どれも `id` を持つ。`id` の無い既存の選択肢があればテストが落ちる
  - `Waiting` が既にあれば、mutation を呼ばない
  - 既定の Status のフィールドが見つからないときは、見つからない名前を出して終了コード 1 で止まる
  - Todo・In Progress・Done のどれかの名前が無いときは、無い名前を出して止まる
- [ ] T002 [US4] 既定の Status の読み取りと選択肢の追加を足す。置き場は `p-w/cli/core/github/queries.py` と `p-w/cli/core/github/projects.py`
  - 足す選択肢は、名前 `Waiting`・色 `RED`・説明の英語 1 文
  - GraphQL の `updateProjectV2Field` を使う。research.md の R7 に従う
- [ ] T003 [US4] 設定の `project.fields.status` を読み書きする。直すのは `p-w/cli/core/config.py` と `p-w/cli/commands/project.py`
  - 欄は data-model.md の「プロジェクトの設定に足すキー」のとおり。`id` と、`options` の `todo`・`in_progress`・`done`・`waiting`
  - `status` の無い設定は、今までどおり読める
  - `project init` が `Waiting` を足し、`_sync_project_config` が `status` を書く
  - `project create` は `init` を通るので、新しいボードにも足される
- [ ] T004 [US4] `project init` と `project create` の定義書を直す。`p-w/interface/authored.yaml` の `details`・`effects`・振る舞いの項目に、既定の Status への追加を書く。対応する pytest に `verifies` を付ける
- [ ] T005 [P] [US4] ボードの説明を直す（FR-044）
  - `p-w/skills/w-help/references/board-status.md` に、In Review の行を足す
  - 同じファイルに、既定の Status の 4 つの値と、動かすものを書く。Todo・In Progress・Done は既定の自動化、`Waiting` は自動処理だ
  - `p-w/skills/w-help/references/spec-driven-workflow.md` の表に、In Review を足す
  - `p-w/skills/w-backlog/SKILL.md` の表が実装と合っているかを確かめ、違えば直す
- [ ] T006 [P] [US4] `p-w/skills/w-onboarding/SKILL.md` の `board_url` を取るスクリプトを直す。`.active` の中身は `.json` で終わるので、`.json` を重ねて足さない
- [ ] T007 [US4] このリポのボードで `pecot project init` を打ち、`Waiting` が足されたことを画面で確かめる。前後で、カードの既定の Status の値が変わっていないことを確かめる。`.pecot/config/projects/` の設定の差分をコミットする
- [ ] T008 [US4] version plan を `.nx/version-plans/` に足す

**Checkpoint**: ボードに `Waiting` があり、設定ファイルから ID を引ける

---

## Phase 2: User Story 1・3・4 — 判定と結果を CLI が扱う (Priority: P1)

**Goal**: `pecot auto gate`・`start`・`finish` が動く。対象外と上限の判定、結果のコメント、待ちの値、起動ラベルを外すことを、エージェントなしで確かめられる

**Independent Test**: 手元で、イベントの JSON の fixture を `pecot auto gate` に渡す。data-model.md の表のとおりの `kind` と `proceed` が出る。
試し用の Issue に `pecot auto finish --result question` を打つと、結果のコメントが付き、札が `Waiting` になり、起動ラベルが外れる。`pecot auto start` を打つと、札が Todo に戻る

- [ ] T009 [P] [US1] `p-w/cli/tests/unit/` に、判定の失敗するテストを書く。対象は `p-w/cli/core/auto/` の関数で、入力は Issue・コメント・イベントの値だ
  - data-model.md の「種類の決まり方」の表の 7 行を、1 行ずつ確かめる
  - 「対象外の条件」の表の 6 行を、1 行ずつ確かめる。進行の欄は、Backlog・Pending・Archived の 3 つを別々に確かめる。ボードに無い Issue は、`kind` が `start` で `proceed` が真になる
  - CI を直した回数は、`result=ci-fix-pushed` の目印を持つコメントの数で数える
  - `workflow_run` で、Issue に同じブランチの `pr-created` の目印が無ければ、`proceed` は偽で、何も書かない
  - 雛形の 1 行目の版が CLI の持つ版より古ければ、`template_outdated` が真になる
- [ ] T010 [P] [US3] `p-w/cli/tests/unit/` に、結果の失敗するテストを書く
  - data-model.md の「結果」の表の 8 行で、既定の Status を書くか、起動ラベルを外すかを確かめる
  - 目印の行の形は `<!-- pecot-auto: result=<結果> run=<run の ID> branch=<ブランチ> -->`
  - 同じ run の目印を持つコメントがあれば、`--ensure` は書かない
  - `--ensure` は、job が時間切れか取り消しなら `limit`、それ以外の失敗なら `failed` にする
- [ ] T011 [US1] `p-w/cli/core/auto/` を作り、T009・T010 のテストを通す。種類と結果の値は data-model.md のとおりにする。GitHub の呼び出しは `p-w/cli/core/github/` を通す
- [ ] T012 [P] [US3] 結果のコメントのテンプレート `p-w/cli/templates/comment/auto-result.md` を作る
  - 欄は data-model.md の「結果のコメント」の表のとおり
  - テンプレートの種類を、次の 3 か所に足す
    - `p-w/cli/core/frontmatter.py` の `CommentTemplate`
    - `p-w/cli/core/sections.py` の章の規則
    - `p-w/cli/commands/issue.py` の help の文言
  - Node 側の写しを合わせる。`p-w/cli-node/src/domain/frontmatter.ts` と `p-w/cli-node/tests/python-output/frontmatter.json`
  - `p-w/cli/tests/cli/test_template_hygiene.py` の表に足す
- [ ] T013 [US1] `p-w/cli/commands/auto.py` を作り、`gate` を足す。`p-w/cli/commands/main.py` に `auto` を登録する
  - 引数と出力は contracts/cli-commands.md の `pecot auto gate` のとおり
  - stdout に JSON を出し、`GITHUB_OUTPUT` があれば同じ値を足す
  - `proceed` が偽で、Issue に知らせる理由があるときは、結果のコメントを書く
  - `proceed` が偽でも、終了コードは 0
- [ ] T014 [US3] `p-w/cli/commands/auto.py` に `start` を足す
  - 出すものは contracts/cli-commands.md の `pecot auto start` の表のとおり
  - `answers` は、`author_association` が OWNER・MEMBER・COLLABORATOR のコメントに限る。ほかの人のコメントは、数だけを出す
  - 既定の Status が `Waiting` なら、PR が無ければ Todo に、あれば In Progress に戻す。`Waiting` でなければ書かない
  - Issue がボードに無ければ、進行の欄を Ready にして載せる。`pecot add-to-project` と同じ関数を使う
- [ ] T015 [US3] `p-w/cli/commands/auto.py` に `finish` を足す
  - 振る舞いは contracts/cli-commands.md の `pecot auto finish` の表のとおり
  - 既定の Status に `Waiting` が無いときは、結果のコメントに足りない設定を足し、終了コード 0 で終わる
  - 起動ラベルが既に外れていても、失敗にしない
  - 進行の欄は書かない
- [ ] T016 [US1] 3 つのコマンドの CLI のテストを `p-w/cli/tests/cli/test_auto.py` に書く。HTTP だけをモックし、渡した値と出力の行を比べる。設定に `fields.status` が無いときは、`pecot project init` を案内して終了コード 2 で止まる
- [ ] T017 [US1] 定義書・`commands.md`・parity を、共通の完了条件のとおりに直す。対象は `auto gate`・`auto start`・`auto finish` の 3 つ
- [ ] T018 [US3] 試し用の Issue で、`finish --result question`、`start`、`finish --ensure` を順に打つ。コメント・札・ラベルを画面で確かめ、出た行と画面を PR に貼る
- [ ] T019 [US1] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 判定と結果の書き込みが、エージェントなしで通る

---

## Phase 3: User Story 1・3 — スキル `w-auto` で、ラベルから PR までの手順を書く (Priority: P1) 🎯 MVP

**Goal**: `/pecot-w:w-auto start <Issue>` と `resume` の手順が、配布するスキルとしてある。人を待つ箇所が無い

**Independent Test**: 手元の Claude Code で、試し用の Issue に `/pecot-w:w-auto start <owner/repo/N>` を打つ。承認も質問の入力も求められずに、計画のコメント・ブランチ・PR・結果のコメントができる。直し方が決まらない Issue では、PR ができず、質問の結果のコメントが付く

- [ ] T020 [US1] `p-w/scripts/ci/tests/test_skill_flow_structure.py` に、w-auto の手順の、失敗するテストを足す
  - `start` の Step の順が、contracts/skill-flow.md の表の 1〜11 のとおり
  - `ci-fix` の節は、Phase 5 で足す。このフェーズでは無くてよい
  - 本文に `EnterPlanMode`・`AskUserQuestion`・`--no-verify` が無い
  - 止まる手順のすべてに、`pecot auto finish` の呼び出しがある
- [ ] T021 [US1] `p-w/skills/w-auto/SKILL.md` を書く
  - frontmatter は contracts/skill-flow.md の「frontmatter」の表のとおり。`allowed-tools` は書かない
  - 「共通の決まり」の 7 つを、手順の前に置く
  - `start` と `resume` の手順を、表の Step の順で書く
  - ブランチは `pecot create-branch <Issue> feat/<説明>` で作る。w-active と同じ規則だ
  - PR の `screenshot` の欄には、無人の実行である理由を書くと指示する
- [ ] T022 [US3] `p-w/skills/w-auto/SKILL.md` に、小さなタスクの範囲の目安と、質問の書き方を書く（FR-014）。中身は contracts/skill-flow.md の 2 つの節のとおり
- [ ] T023 [US1] スキルの一覧に w-auto を足す
  - `p-w/skills/w-help/references/skills.md`
  - `p-w/skills/w-help/SKILL.md` の用途別の表
  - `p-w/README.md` のスキルの表
- [ ] T024 [US1] プラグインの hooks が、w-auto の手順を止めないことを確かめる（research.md の R11）
  - スキルやブランチの名前を見ている、次の 4 つを読む
    - `p-w/hooks/lib/user-prompt-submit/create-slash-flag.sh`
    - `p-w/hooks/lib/user-prompt-submit/pecot-issue-pending-state.sh`
    - `p-w/hooks/lib/post-tool-use/pecot-skill-reminder.sh`
    - `p-w/hooks/lib/core/branch-guard.sh`
  - 止める箇所があれば、w-auto を扱うように直し、hooks のテストを足す
- [ ] T025 [US1] 手元の Claude Code で、直し方が決まる試し用の Issue に `start` を打つ。計画のコメント・PR・結果のコメントを確かめ、PR に貼る
- [ ] T026 [US3] 手元の Claude Code で、直し方が 2 通りある試し用の Issue に `start` を打つ。質問の結果のコメントを確かめる。答えを書いて `resume` を打ち、同じ質問が繰り返されず、ブランチが 1 本のままであることを確かめる
- [ ] T027 [US1] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 手元で打てば、Issue から PR までが人を待たずに進む

---

## Phase 4: User Story 1・2 — ワークフローの雛形を配り、ラベルで起動する (Priority: P1)

**Goal**: `pecot auto install` が雛形を書き出し、起動ラベルを作る。このリポで、Issue に起動ラベルを付けると PR ができる。起動者・ツール・ターン・時間・同時実行の制限が、何も変えない状態で有効だ

**Independent Test**: quickstart.md の「ラベルから PR まで」と「安全策」の表を、このリポでたどる

- [ ] T028 [P] [US2] `p-w/cli/tests/` に、雛形の失敗するテストを書く。確かめることは contracts/workflow-template.md の「テストで確かめること」の表の 8 行
- [ ] T029 [US1] 雛形 `p-w/cli/templates/workflow/pecot-auto.yml` を作る。このフェーズでは、契機は `issues: labeled` だけにする
  - 1 行目に版の目印 `# pecot-auto-template: 1` を置く
  - 先頭の `env` に、contracts/workflow-template.md の「先頭に置く値」の 4 つを置く
  - job `gate` と `run` を、同じ文書の表のとおりに書く
  - 起動ラベルの名前の判定を、ワークフローの `if` に書く
  - `run` の同時実行は `group: pecot-auto-<gate の number>` と `cancel-in-progress: false`
  - claude-code-action の入力は、同じ文書の表のとおり。`allowed_non_write_users` は書かない
  - `prompt` には `/pecot-w:w-auto <kind> <issue>` だけを書く。Issue の本文・タイトル・コメントを式で埋め込まない
  - `--allowedTools` は、同じ文書の「許可するツール」の表のとおり
  - 利用者が足す 2 か所を、開始と終了の印のコメントで囲む
  - 最後の step は `if: always()` で `pecot auto finish --ensure` を呼ぶ
- [ ] T030 [US1] `p-w/cli/pyproject.toml` の package-data に、`templates/workflow/` が入ることを確かめる。入らなければ足す
- [ ] T031 [US1] `p-w/cli/commands/auto.py` に `install` を足す
  - 引数と振る舞いは contracts/cli-commands.md の `pecot auto install` のとおり
  - `--ci-workflow` を省くと、`.github/workflows/` の `name` の候補を出して終了コード 2 で止まる
  - 書き出しのとき、有効な設定の名前と、CI のワークフローの名前を埋める
  - 起動ラベルを、名前・説明・色をつけて作る。既にあれば作らない
  - 書いた後に、利用者がすることを順に出す。App の作成、変数と secret の登録だ
  - `--check` は、置かれたファイルの版の目印を比べる
  - `--force` は、囲みの中の行を出してから上書きする
- [ ] T032 [US1] `install` の CLI のテストを `p-w/cli/tests/cli/test_auto.py` に足す。書き出した結果に、このリポ固有の名前が残らないことも確かめる
- [ ] T033 [US1] 定義書・`commands.md`・parity を、共通の完了条件のとおりに直す。対象は `auto install`
- [ ] T034 [US2] このリポに導入する。利用者の作業を先に頼む
  - 利用者が GitHub App を作り、organization の全リポにインストールする。権限は research.md の R2 の表
  - 利用者が、変数 `PECOT_AUTO_APP_CLIENT_ID` と、secret `PECOT_AUTO_APP_PRIVATE_KEY`・`ANTHROPIC_API_KEY` を登録する。登録は organization の単位にする。T053 の試し用のリポにも届く
  - `pecot auto install --ci-workflow <このリポの CI の名前>` で `.github/workflows/pecot-auto.yml` を書き出す
  - `.claude/rules/github-workflows.md` と CLAUDE.md のワークフローの一覧に足す
- [ ] T035 [US1] `allowed_bots` に書く App の名前の形を、action のソースで確かめる（research.md の R3）。このフェーズでは値を空にしておき、確かめた形を Phase 5 の雛形に使う
- [ ] T036 [US1] quickstart.md の「ラベルから PR まで」の表を、このリポの試し用の Issue でたどる。結果を PR に貼る
- [ ] T037 [US2] quickstart.md の「安全策」の表をたどる。別のアカウントは使わない。結果を PR に貼る
  - 起票・コメント・本文の編集で起動しないことは、保守者のアカウントで確かめる。起動するかは操作の種類で決まる
  - 許可されていない起動者の拒否は、このリポの別の App のトークンでラベルを付けて確かめる。付ける手段は、手で起動する一時のワークフローにする。確かめた後に消す
  - 外部の人の本文に従わないことは、同じ文面の Issue を起票して確かめる
  - triage ロールの人の拒否は、実物で確かめない。action の `v1.0.271` の `src/github/validation/permissions.ts` を読み、admin と write だけが通ることを PR に書く
- [ ] T038 [US1] version plan を `.nx/version-plans/` に足す

**Checkpoint**: このリポで、起動ラベルを付けると PR ができる。外部のアカウントからは起動しない

---

## Phase 5: User Story 1 — PR の CI が落ちたら、上限の回数まで直す (Priority: P1)

**Goal**: 自動処理が作った PR の CI が落ちると、別の run が起きて同じブランチで直す。CI が通るか、上限に達すると、結果のコメントが付く。人が作った PR では動かない

**Independent Test**: quickstart.md の「CI の修正」の表を、このリポでたどる

- [ ] T039 [US1] `p-w/scripts/ci/tests/test_skill_flow_structure.py` に、`ci-fix` の手順の、失敗するテストを足す。Step の順が contracts/skill-flow.md の表の 1〜7 のとおりで、本文に force push の指示が無い
- [ ] T040 [US1] `p-w/skills/w-auto/SKILL.md` に、`ci-fix` の手順を書く
  - 落ちたチェックとログは `gh pr checks` と `gh run view --log-failed` で読む
  - 失敗が変更と関係しなければ、直さずに `failed` で終わる
  - ブランチの先頭に人のコミットが載っていれば、上書きせずに `failed` で終わる
  - 回数は数えない。`gate` が数える
- [ ] T041 [US1] 雛形 `p-w/cli/templates/workflow/pecot-auto.yml` に、契機 `workflow_run` の `completed` を足す
  - `workflows` は、書き出しのときに埋める CI の名前
  - `gate` に、`--event-name workflow_run` と `--max-ci-attempts` を渡す
  - `run` の checkout は、`ci-fix` のとき `gate` の `branch` を使う
  - `allowed_bots` に、T035 で確かめた形で、自前の App の名前を書く。`*` は使わない
  - 版の目印を 2 に上げる
- [ ] T042 [US1] `gate` の `workflow_run` の判定を、実物のイベントの JSON で確かめる。fixture を `p-w/cli/tests/` に足す
  - CI が通ったとき、`ci-passed` の結果のコメントを書き、`proceed` は偽
  - 上限に達したとき、`limit` の結果のコメントを書き、札を `Waiting` にする。`proceed` は偽
  - fork の PR と、人が作った PR では、何も書かない
- [ ] T043 [US1] 雛形のテストを直す。契機が 2 つあること、`allowed_bots` が `*` でないことを確かめる
- [ ] T044 [US1] このリポの `.github/workflows/pecot-auto.yml` を、`pecot auto install --force` で書き出し直す。`pecot auto install --check` が、古い雛形で終了コード 1 を返すことを先に確かめる
- [ ] T045 [US1] quickstart.md の「CI の修正」の表を、このリポでたどる。結果を PR に貼る
- [ ] T046 [US1] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 起動ラベルを付ける 1 回の操作で、CI の通った PR ができる

---

## Phase 6: User Story 5 — onboarding の流れで導入し、設定を確かめられる (Priority: P3)

**Goal**: 利用者が、w-onboarding の流れで自動処理の導入を選べる。`pecot auto doctor` が、足りない設定を名前で示す

**Independent Test**: quickstart.md の「導入」の表をたどる。自動処理を入れていない試し用のリポで、示された手順だけで導入し、起動ラベルで PR ができる

- [ ] T047 [P] [US5] `p-w/cli/tests/cli/test_auto.py` に、`doctor` の失敗するテストを書く。contracts/cli-commands.md の「確かめる項目」の表の 10 行を、1 行ずつ確かめる。権限が無く読めない項目は `skipped:` で出し、足りないと数えない
- [ ] T048 [US5] `p-w/cli/commands/auto.py` に `doctor` を足す
  - secret と変数は、名前の有無だけを読む。値は読まない。リポの単位と organization の単位の両方を見る
  - ボードの既定の自動化は、`workflows` の `enabled` を読む
  - 何も書かない
- [ ] T049 [US5] 定義書・`commands.md`・parity を、共通の完了条件のとおりに直す。対象は `auto doctor`
- [ ] T050 [US5] `p-w/skills/w-onboarding/SKILL.md` に、自動処理の導入の Step を足す（FR-030・FR-031）
  - 使うかを AskUserQuestion で尋ねる。使わないと答えたら、何も置かずに次へ進む
  - 使うなら、次の順に進める。`pecot project init`、GitHub App の作成、変数と secret の登録、`pecot auto install`、`pecot auto doctor`
  - 手順が長くなるので、詳細は `p-w/skills/w-onboarding/references/auto-setup.md` に置く
- [ ] T051 [US5] `p-w/skills/w-onboarding/references/auto-setup.md` を書く
  - GitHub App に要る権限を、最小の範囲で列挙し、それぞれの使い道を書く（FR-019）。中身は research.md の R2 の表
  - 保護されたブランチの ruleset があることを、前提として書く（FR-029）
  - 利用者が足す 2 か所（準備の step、テストのコマンドの許可）の書き方
  - 上限の 3 つの値の変え方
  - ビューで既定の Status の札を隠していると、待ちの値が見えないこと
  - App のインストール先と secret の単位の選び方。使うリポだけに絞る形を勧める
  - user 所有のボードは対象外であること
  - GHES は未確認であること
  - 雛形の更新の手順。`pecot auto install --check` と `--force`
- [ ] T052 [P] [US5] `p-w/skills/w-help/references/auth-config.md` に、GitHub App のトークンの渡し方を足す。環境変数 `PECOT_GITHUB_COM_TOKEN` で渡す
- [ ] T053 [US5] 試し用のリポで、w-onboarding の手順だけをたどって導入する。起動ラベルで PR ができることを確かめる。手順の抜けを直す
  - リポは `gh repo create` で organization に作る。README と、落ちるテストを 1 つ持つ小さなコードを置く
  - 変数・secret・App は organization の単位なので、作ったリポに初めから届く
  - 確かめた後のリポの削除は、利用者の確認を得てから行う
- [ ] T054 [US5] version plan を `.nx/version-plans/` に足す

**Checkpoint**: このリポのことを知らない利用者が、手順だけで導入できる

---

## Phase 7: 全ストーリー — このリポで通して確かめ、既定値を直す (Priority: P2)

**Goal**: quickstart.md の全部の表が通る。ターン・時間・CI を直す回数の既定値が、試した結果に合っている

**Independent Test**: quickstart.md を上から下までたどり、期待と違う行が無い

- [ ] T055 quickstart.md の「ボード」の表をたどる。6 つの時点で、列と札を画面で確かめ、スクリーンショットを残す
- [ ] T056 このリポの大きさの違う Issue を 5 件以上、自動処理で進める。run ごとに、ターンの数・時間・結果を記録する。記録は `.pecot/work/315/` に置く
- [ ] T057 T056 の記録から、雛形の既定値（80 ターン・30 分・CI の修正 3 回）を直す。直したら、版の目印を上げ、`p-w/skills/w-onboarding/references/auto-setup.md` の数も合わせる
- [ ] T058 spec.md の Success Criteria の SC-001〜SC-011 を、1 つずつ確かめる。確かめた方法と結果を、Epic #315 のコメントに書く
- [ ] T059 [P] specs/023-label-triggered-autofix/ の文書を、実装の結果に合わせる。research.md の「残した判断」の表と、contracts/ の 3 つの文書に、定義書を正とする 1 行を足す
- [ ] T060 version plan を `.nx/version-plans/` に足す。既定値を直さなかったときは要らない

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 理由 |
|---|---|---|
| 1 | 無い | — |
| 2 | 1 | `start` と `finish` が、設定の `fields.status` と `Waiting` を使う |
| 3 | 2 | スキルが `pecot auto start`・`finish` を呼ぶ |
| 4 | 2 | 雛形が `pecot auto gate`・`finish --ensure` を呼ぶ |
| 5 | 3・4 | スキルと雛形の両方に、CI を直す種類を足す |
| 6 | 4 | `doctor` が、置かれた雛形と起動ラベルを確かめる |
| 7 | 5・6 | 全部がそろってから通して確かめる |

Phase 4 の T036・T037 は、Phase 3 のスキルが main に入ってから動かす。action は、既定のブランチのプラグインを入れるからだ。雛形と `install` の実装（T028〜T033）は、Phase 3 と並べて進められる。

### User Story Dependencies

| ストーリー | 終わるフェーズ | 依存 |
|---|---|---|
| US4（ボード） | 1 と 2。画面の確認は 7 | 無い |
| US3（質問と起動し直し） | 3 | 2 |
| US1（ラベルから PR まで） | 4。CI の修正は 5 | 2・3 |
| US2（安全策） | 4 | 2 |
| US5（導入） | 6 | 4 |

### Parallel Opportunities

- Phase 3 と Phase 4 は、Phase 2 の後に並べて進められる。確認のタスク（T036・T037）だけが Phase 3 を待つ
- Phase 5 と Phase 6 は、Phase 4 の後に並べて進められる。Phase 5 は Phase 3 も待つ
- フェーズの中では、`[P]` のタスクを並べて進められる

## Parallel Example

Phase 2 の始めに、次の 3 つを並べて進める。

```text
T009 判定の失敗するテスト（p-w/cli/tests/unit/）
T010 結果の失敗するテスト（p-w/cli/tests/unit/）
T012 結果のコメントのテンプレート（p-w/cli/templates/comment/auto-result.md）
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
| T034 | GitHub App の作成と、organization の全リポへのインストール。変数と secret の、organization の単位での登録 |
| T053 | 確かめた後の、試し用のリポの削除の確認 |
