# Feature Specification: PR ごとのテストとリリースを CI で動かし、ローカルフックと CI の役割を分け直す

**Feature Branch**: `019-ci-pr-tests`

**Created**: 2026-11-05

**Status**: Draft

**Input**: Epic pecotcraft/pecot#35「PR ごとのテストを CI で動かす — dependabot の PR も手を使わずに検証してマージできる」。ユーザーの追加指示として、pre-commit / pre-push などのローカルフックと CI の役割も再整理する。

## 背景

今の検証の置き場は次のとおり（2026-11-05 時点、`main`）。

| 置き場 | 動くもの | 前提 |
|---|---|---|
| pre-commit | 単機能のガード（禁止ディレクトリ・文言規則・version plan の形・plugin validate など）と、staged ファイルに絞った `nx affected` の lint | 開発者の devcontainer |
| commit-msg | 保護ブランチへの直接 commit の拒否、commit メッセージの文言規則 | 同上 |
| pre-push | push range の文言規則・version plan の要否・githooks のテスト・nx の env 入力の宣言・ブランドの語・`nx affected` の test レーン | 同上。ブランドの語の一覧はリポジトリの外にある |
| GitHub Actions | npm への publish（`publish-npm.yml`）だけ | — |

困っていることは次のとおり。

- PR にテストの結果が付かない。検証の有無は、author の手元で pre-push が通ったことに依拠している
- dependabot の PR には author の手元が無い。そのため、人が 1 件ずつ main に重ねてテストしている
- テストは devcontainer の LibreOffice・フォント・awscli 2.39.4・actionlint 1.7.12・Node.js 24.22.1・uv などを前提にしている。devcontainer の外では再現できない
- pre-commit・pre-push と、これから作る CI のあいだで、何をどこに任せるかが決まっていない。CI を足すだけだと、同じテストを手元と CI で 2 回待つ
- CLAUDE.md と `.githooks/README.md` は「GitHub Actions は publish だけ」「品質は手元の pre-commit に依拠」と書いている

リポジトリは public で、`main` にブランチ保護は無い。
リリースは、開発者が手元の `base/pecot` で `npx nx release` を実行し、`main` へ直接 push している。

## Clarifications

### Session 2026-11-05

- Q: pre-push の `nx affected` の test レーンは、CI を作った後にどう扱うか → A: pre-push から外す。test レーンは CI だけが担う。手で 1 レーンを動かす方法は残す
- Q: pre-commit の lint と、pre-push の githooks-tests はどう扱うか → A: lint は pre-commit に残し、CI と二重にする。理由は、staged に絞れて速く、commit の前に直せることである。githooks-tests はテストなので CI へ移す
- Q: `main` に必須チェックを入れたとき、`nx release` の直接 push をどう通すか → A: リリースもこの Epic で整備する。`nx release` は GitHub Actions のランナーで動かし、その実行の actor を ruleset の bypass に載せる
- Q: ランナーでのリリースに、ブランドの語の一覧をどう渡すか → A: 名前の移行は済んでいるので、ブランドの語の確認そのものが不要。pre-push の確認・リリースの監査・CLAUDE.md の節を廃止する
- Q: dependabot の PR の version plan をどう扱うか → A: 依存の更新が CHANGELOG に載らないのは困る。配布物に届く更新（実行時の依存・同梱される lock）には、patch の version plan を足す。開発用だけの更新には要求しない。版が上がるのは、次に人がリリースしたときである
- Q: pre-push に残る 3 つ（`check-text-push`・`check-version-plan-required`・`nx-env-inputs`）をどうするか → A: 残す。hook のスクリプトを stage ごとのディレクトリに移し、どこで何が動くかを置き場所で分かるようにする（FR-016a）
- Q: `main` への push でも CI を動かすか → A: 動かす。release commit と bypass の push は PR を経ないので、`main` へ載った後で検証する（FR-001a）
- Q: 個人情報の削除などで `main` を force push する緊急時をどう扱うか → A: version plan は要らない。ruleset を一時的に外す手順を書き、CI とリリースが書き換え後の履歴で正しく動くようにする（FR-028〜030）
- Q: squash で残る dependabot の英語の件名を、件名に日本語を求める規約でどう扱うか → A: dependabot の件名を規約の例外にする（FR-014）
- Q: 依存の更新の version plan の文面をどう書くか → A: PR ごと・group ごとに 1 行で、FR-015b のとおりにする
- Q: dependabot の更新の version plan をどの時点で足すか → A: リリース時に作る。PR に commit を積むと、dependabot の rebase と自動マージの検証が止まるためである（FR-015a）

## User Scenarios & Testing *(mandatory)*

### User Story 1 - PR を開くと、変更が届いたレーンの検証が動いて結果が PR に付く (Priority: P1)

開発者やエージェントが PR を開く・更新すると、変更が届いた nx のレーン（test と lint）だけが、devcontainer と同じ環境で動く。
結果は PR のチェックとして表示される。落ちたときは、落ちたレーンとその出力を PR から辿れる。

**Why this priority**: 自動マージと役割の再整理は、PR に信頼できる検証結果が付くことを前提にする。これだけでも「手元で通した」という自己申告を、誰でも確かめられる結果に置き換えられる。

**Independent Test**: 次の 3 つの PR を開いて確かめる。

- 1 つのプラグインだけを変える PR では、そのプラグインのレーンだけが動いて結果が付く
- 文書だけを変える PR では、レーンが選ばれずに成功で終わる
- わざとテストを壊した PR では、チェックが失敗し、失敗したレーン名が PR から分かる

**Acceptance Scenarios**:

1. **Given** pecot-visual の CLI だけを変えた PR、**When** PR を開く、**Then** pecot-visual の該当レーンだけが動き、結果が PR のチェックに付く。他のプラグインのレーンは動かない
2. **Given** devcontainer にしか無いツールを使うレーンに変更が届いた PR、**When** 検証が動く、**Then** 手元の devcontainer と同じ結果になる。環境の差で落ちたり飛ばされたりしない
3. **Given** テストを 1 件壊した PR、**When** 検証が動く、**Then** チェックは失敗になり、失敗したレーン名と出力を PR から開ける
4. **Given** 文書だけを変えた PR、**When** 検証が動く、**Then** レーンが選ばれず、チェックは成功で終わる。「対象なしで成功」と表示から分かる
5. **Given** 同じ PR に続けて push した、**When** 新しい検証が始まる、**Then** 古い push の検証は打ち切られ、最新の commit の結果だけが PR に残る

---

### User Story 2 - テストが通った dependabot の minor・patch の PR は、人が触らずにマージされる (Priority: P2)

dependabot が minor・patch の更新 PR を開くと、US1 の検証が動く。すべて通れば、その PR は自動でマージされる。
major の更新と、検証が落ちた PR はマージされずに残り、人が判断する。
配布物に届く更新の version plan は、リリースの workflow が作る。依存の更新は、次のリリースの CHANGELOG に載る。

**Why this priority**: Epic を起こしたきっかけは、dependabot の PR が 17 件溜まったことだった。この話がそれを解消する。US1 を前提にするので P2 にする。

**Independent Test**: 次の 2 つを確かめる。

- dependabot の minor か patch の PR が 1 件、検証に通り、人の操作なしにマージされる
- major の PR と、検証の落ちた PR は、マージされずに残る

**Acceptance Scenarios**:

1. **Given** dependabot が開いた patch の更新 PR、**When** 検証がすべて通る、**Then** 人の操作なしにマージされる
2. **Given** dependabot が開いた major の更新 PR、**When** 検証が通る、**Then** 自動ではマージされず、人の判断を待つ
3. **Given** dependabot の minor の PR で検証が落ちた、**When** 検証が終わる、**Then** マージされずに残る。落ちた理由は PR から分かる
4. **Given** 人が開いた PR、**When** 検証が通る、**Then** 自動ではマージされない。自動マージは dependabot の minor・patch に限る
5. **Given** 自動マージで main が進んで古くなった dependabot PR、**When** dependabot が PR を rebase する、**Then** 検証が動き直す。通ればマージされる
6. **Given** pecot-visual の実行時の依存を上げる dependabot の PR、**When** CI が動く、**Then** PR に commit は積まれない。検証が通れば自動でマージされる
7. **Given** 6 の PR がマージされた後のリリース、**When** CHANGELOG を見る、**Then** 依存の更新が pecot-visual の patch の行として載っている
8. **Given** 開発用の依存だけを上げた dependabot の PR がマージされた後のリリース、**When** CHANGELOG を見る、**Then** その更新の行は無い

---

### User Story 3 - pre-commit・pre-push・CI の役割が分かれていて、同じ検証を二度待たない (Priority: P2)

開発者は、commit・push・PR のそれぞれで何が検証されるかを、1 か所の表で確かめられる。各検証の置き場は 1 つに決まっている。
手元のフックは速いガード（数秒〜数十秒）を中心にし、時間のかかるテストの全量は CI が担う。
手元に残す検証と CI と重ねる検証には、理由を表に書く。
ブランドの語の確認は、名前の移行が済んだので廃止する。

**Why this priority**: CI を足すだけでは、手元と CI で同じテストを二重に待つ。ユーザーの追加指示により、CI と同じ Epic で扱う。

**Independent Test**: 役割の表と、`.pre-commit-config.yaml` と CI の定義を照らし合わせる。すべての検証が 1 つの置き場に割り当てられていることを確かめる。意図して重ねたものには理由が書いてあること。典型的な 1 プラグインの変更で、push にかかる時間を整理の前後で比べる。

**Acceptance Scenarios**:

1. **Given** 役割の表、**When** 今ある hook と CI のジョブをすべて並べる、**Then** 各検証の置き場が表に 1 つずつ書いてある。表に無い検証も、実体の無い表の行も無い
2. **Given** 1 つのプラグインのソースを変えたブランチ、**When** push する、**Then** 手元で待つ時間は整理前より短い。重いテストの結果は PR の CI で付く
3. **Given** pre-commit と CI の両方で動く lint、**When** 役割の表を読む、**Then** 二重にする理由が書いてある
4. **Given** CI だけで動くようになった検証、**When** 開発者が CI を待たずに手元で確かめたい、**Then** 手で 1 レーンだけ動かす方法が文書にある
5. **Given** 整理後の hook とリリースの手順、**When** ブランドの語の確認を探す、**Then** 確認も、一覧を渡す環境変数の参照も残っていない

---

### User Story 4 - リリースを GitHub Actions のランナーで実行する (Priority: P2)

リリース担当者は、手元の `base/pecot` でなく GitHub Actions の workflow を起動してリリースする。
`nx release` はランナーで動き、版の更新・CHANGELOG・tag・Release を作り、`main` へ push する。
`main` の ruleset は PR と必須チェックを要求する。リリースの push は、workflow の actor を bypass に載せて通す。人の直接 push は通さない。

**Why this priority**: 自動マージには `main` の必須チェックが要る。必須チェックを入れると、手元からの直接 push によるリリースが通らなくなる。US2 と同時に要る。

**Independent Test**: 次の 2 つを確かめる。

- version plan のある `main` で workflow を起動すると、ランナーでリリースが終わり、版・CHANGELOG・tag・Release がそろう
- 人が `main` へ直接 push すると拒否される

**Acceptance Scenarios**:

1. **Given** 未リリースの version plan がある `main`、**When** 担当者がリリースの workflow を起動する、**Then** ランナーで `nx release` が動く。release commit と tag が `main` に載る
2. **Given** PR と必須チェックを要求する ruleset、**When** リリースの workflow が `main` へ push する、**Then** bypass の actor として通る
3. **Given** 同じ ruleset、**When** 人が手元から `main` へ直接 push する、**Then** 拒否される
4. **Given** MCP サーバの配布物を持つ group のリリース、**When** リリースが終わる、**Then** npm への publish が今と同じ結果になる
5. **Given** リリースの途中で失敗した、**When** 担当者が手順に従う、**Then** 手元の環境を使わずに状態を確かめ、やり直せる

---

### User Story 5 - 文書が、CI がテストとリリースを担う前提で書かれている (Priority: P3)

開発者とエージェントは、CLAUDE.md と `.githooks/README.md` を読めば次のことが分かる。

- テストとリリースを誰がどこで担うか
- PR を出す前に手元で何をすればよいか
- CI が落ちたときにどう再現するか

**Why this priority**: 文書の更新は US1〜US4 の結果を書くもので、単独では価値を持たない。

**Independent Test**: CLAUDE.md と `.githooks/README.md` を読んで、次の 2 点を確かめる。

- 「GitHub Actions は publish だけ」「品質は手元の pre-commit に依拠」の記述が残っていない
- リリースを手元の `base/pecot` で実行する記述と、ブランドの語の確認の節が残っていない
- US3 の役割の表と食い違う記述が無い

**Acceptance Scenarios**:

1. **Given** 更新後の CLAUDE.md、**When** テストの実行の項を読む、**Then** CI が PR ごとにテストを担うと書いてある。手元で動かすのは、変更箇所に絞ったテストと CI の失敗の再現だけだと書いてある
2. **Given** CI のチェックが落ちた PR、**When** 開発者が文書に従う、**Then** 落ちたレーンを手元の devcontainer で再現できる

---

### Edge Cases

| 場面 | 期待する扱い |
|---|---|
| base と比べる範囲 | PR の affected の範囲は、base（`main`）との merge-base から PR の先頭までにする。手元の pre-push の push range と同じ考え方で、手元と CI で選ばれるレーンをずらさない |
| 全 project に関わる変更 | `nx.json`・ルートの `package.json`・lock・CI の定義そのものを変えた PR では、全レーンを選ぶ。CI の定義を変えた PR では、CI 自身が検証される |
| fork からの PR | public リポなので fork から PR が来うる。秘密を使う処理は fork の PR で動かさない。テストは秘密なしで動く |
| dependabot の PR と秘密 | dependabot の PR に渡る秘密は、通常の PR と別扱いになる。テストが秘密なしで通る前提を保つ |
| 環境の版のずれ | devcontainer の定義（Node.js・awscli・actionlint の版など）を変えた PR では、CI の環境も同じ PR の定義で作る。古い環境では検証しない |
| キャッシュ | CI で nx のタスクキャッシュを使う場合も、結果が食い違えば手元の devcontainer での再実行を正とする。落ちるべきテストがキャッシュで通ってはならない |
| CI の基盤の障害 | Actions が動かない・環境の構築に失敗したときは、チェックを「失敗」にし、自動マージを止める。テストの失敗と基盤の失敗は PR 上で見分けられる |
| 時間切れ | レーンが異常に長くかかったら、上限の時間で打ち切って失敗にする |
| release の commit | ランナーの `nx release` による commit と tag は PR を経ず、bypass の actor で `main` に載る。`main` への push で CI が動き、release commit も検証される |
| リリースの同時起動 | リリースの workflow を続けて起動したときは、後の起動を待たせるか止める。2 つのリリースを同時に動かさない |
| リリース中の main の前進 | リリースの途中で自動マージが `main` を進めたときは、push を失敗にして止める。release commit を古い base に載せない |
| 自動マージの同時進行 | 複数の dependabot PR が同時に通ったとき、先にマージされたもので main が進む。後続は古い base で検証した結果のままマージしない |
| 緊急の force push | 個人情報の削除などで `main` の履歴を書き換える。version plan は要らない。管理者が ruleset を一時的に外し、終わったら戻す |
| 書き換え後の CI | 範囲の base の commit が履歴から消えている。base が解決できなければ、全レーンを動かす |
| 書き換え後のリリース | 配布済みの dependabot の更新が、書き換え後の commit として再び数えられうる。中身が同じ commit は除く |
| フックを飛ばした push | `--no-verify` で手元のフックを飛ばしても、PR の CI で同じテストが動く。version plan の要否も CI で確かめる。検証の抜けは PR で見える |

## Requirements *(mandatory)*

### Functional Requirements

CI での検証（US1）

| ID | 要件 |
|---|---|
| FR-001 | PR の作成・更新のたびに、変更が届いた nx の test レーンと lint レーンを自動で動かす |
| FR-001a | `main` への push でも同じ検証を動かす。範囲は、直前に成功した `main` の検証から push の先頭まで。落ちたら Actions の通知と `main` の履歴で分かる |
| FR-002 | レーンの選び方は手元のフックと同じにする。レーン名を列挙して `nx affected` に要求する。レーンを project.json に足しても、CI の定義は直さずに済む |
| FR-003 | affected の範囲は、PR の base ブランチとの merge-base から PR の先頭 commit までにする |
| FR-004 | 検証は、devcontainer と同じ定義から作った環境で動かす。devcontainer の定義が変われば、CI の環境も同じ PR の中で追従する |
| FR-005 | 結果を PR のチェックとして付ける。失敗したときは、失敗したレーン名とその出力を PR から開ける |
| FR-006 | レーンが 1 つも選ばれない PR では、チェックを成功で終える。対象なしで成功したことが表示から分かる |
| FR-007 | 同じ PR に新しい push が来たら、古い検証を打ち切る |
| FR-008 | 検証に上限の時間を持たせ、超えたら失敗にする |
| FR-009 | 検証は秘密を使わずに動く。fork の PR・dependabot の PR でも同じ結果になる |
| FR-010 | CI の定義は、既存の lint（actionlint）の対象にする |

dependabot の自動マージ（US2）

| ID | 要件 |
|---|---|
| FR-011 | dependabot が開いた minor・patch の更新 PR は、FR-001 の検証がすべて通ったら、人の操作なしにマージする |
| FR-012 | major の更新 PR、dependabot 以外が開いた PR、検証の落ちた PR は、自動でマージしない |
| FR-013 | 自動マージは、最新の base に対して検証が通った状態でだけ行う |
| FR-014 | dependabot の件名（`build(<scope>): bump ...`）を、commit メッセージの日本語の規則の例外にする。例外は `chore(release)` と同じ扱いで、規約の文書にも書く |
| FR-015 | version plan の要否のガードを CI でも PR ごとに動かし、必須チェックにする。範囲内の commit がすべて `dependabot[bot]` の作なら、FR-015a で作るので要求しない。判定は commit の author で行い、PR と merge queue で同じに動く |
| FR-015a | リリースの workflow は、`nx release` の前に、前回のリリース以降にマージされた dependabot の commit を読む。配布物に届く更新（実行時の依存・配布物に同梱される lock）には、その release group の patch の version plan を作り、release commit に含める。dependabot の PR ブランチと `main` には commit を積まない |
| FR-015b | FR-015a で作る version plan は、PR ごと・group ごとに 1 ファイルにする。ファイル名は `<PR 番号>-dependabot-deps.md` とする。本文は「依存を更新した（名前 旧版 → 新版、…）。」の 1 文で、commit の本文の依存の記録から作る。100 字を超えるときは数件で切り「ほか N 件」で締める。足す前に文言規則と version plan の形の確認を通す |

役割の再整理（US3）

| ID | 要件 |
|---|---|
| FR-016 | 今ある検証（pre-commit・commit-msg・pre-push の各 hook と CI のジョブ）の役割の表を 1 か所に置く。表は検証ごとに置き場を 1 つ割り当てる |
| FR-016a | hook のスクリプトを stage ごとのディレクトリ（`.githooks/pre-commit/`・`commit-msg/`・`pre-push/`・`ci/`）に置く。共有の lib とテストは別のディレクトリにする。ディレクトリと `.pre-commit-config.yaml` の stage が一致することをテストで確かめる |
| FR-017 | pre-push から `nx affected` の test レーンと githooks-tests を外し、CI だけで動かす。pre-push は秒単位のガードだけにする |
| FR-018 | pre-commit の `nx affected` の lint は手元に残し、CI と二重にする。理由（staged に絞れて速く、commit の前に直せる）を役割の表に書く |
| FR-018a | ブランドの語の確認を廃止する。対象は pre-push の hook、リリースの監査と publish の確認、そのテスト、CLAUDE.md の節、環境変数 `PECOT_BRAND_TERMS_FILE` の参照である |
| FR-019 | 手元から CI に移した検証は、手で 1 レーンずつ動かす方法を残す |
| FR-020 | CI に移すと弱まる保証があれば、役割の表に書く。補う手段か、受け入れる理由も書く |

リリース（US4）

| ID | 要件 |
|---|---|
| FR-023 | `nx release` を GitHub Actions のランナーで動かす workflow を置く。起動は人が手で行う |
| FR-024 | `main` に ruleset を入れ、PR 経由と必須チェック（FR-001・FR-015）の成功を要求する。bypass はリリースの workflow の actor だけに与える |
| FR-025 | リリースの workflow は、今の手元のリリースと同じ成果物（版・CHANGELOG・tag・Release・MCP の配布物・npm への publish）を作る |
| FR-026 | リリースの workflow は同時に 1 つだけ動く。push の前に `main` が進んでいたら失敗にする |
| FR-027 | 失敗したリリースを確かめてやり直す手順を、w-release スキルと文書に書く |

緊急の force push

| ID | 要件 |
|---|---|
| FR-028 | `main` を force push する緊急時の手順を文書に書く。ruleset を一時的に外す・force push する・ruleset を戻す・CI の結果を確かめる、の順にする |
| FR-029 | `main` への push の CI は、成功した run が無い（`noPreviousBuild`）か、範囲の base の commit を読めないとき、全レーンを動かす |
| FR-030 | `dependabot-plans.js` は、前回の tag の側に中身が同じ commit があるものを数えない |

文書（US5）

| ID | 要件 |
|---|---|
| FR-021 | CLAUDE.md と `.githooks/README.md` を、CI がテストとリリースを担う前提に書き直す。「GitHub Actions は publish だけ」「品質は手元の pre-commit に依拠」「リリースは `base/pecot` で実行」の記述は残さない |
| FR-022 | CI の失敗を手元の devcontainer で再現する手順を文書に書く |

### Key Entities

| 名前 | 中身 |
|---|---|
| レーン | nx project の `test-*` / `lint-*` の target。検証の単位で、affected の判定もレーンごとに行う |
| 検証の置き場 | pre-commit / commit-msg / pre-push / CI の 4 つ。各検証はちょうど 1 つに属する |
| 役割の表 | 検証ごとに、置き場・かかる時間の目安・その置き場にする理由を並べた表 |
| CI の環境 | devcontainer の定義から作る、検証を動かす環境。devcontainer と同じ版のツールを持つ |
| 自動マージの条件 | PR の作成者（dependabot）・更新の種類（minor / patch）・検証の結果（version plan を含めすべて成功）・base の新しさ |
| リリースの actor | リリースの workflow が `main` へ push するときの身元。ruleset の bypass に載る唯一の主体 |

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | 達成の基準 |
|---|---|
| SC-001 | この Epic の後に開いた PR の 100% に、変更が届いたレーンの検証結果が付く |
| SC-002 | 手元の devcontainer と結果が食い違うレーンが 0 件。環境の差で落ちる・飛ばされるレーンが無い |
| SC-003 | 検証の通った dependabot の minor・patch の PR は、人の操作なしにマージされる。溜まる件数は、検証の通らないものと major を除いて 0 件になる |
| SC-004 | 1 つのプラグインのソースを変えた典型的な push で、手元で待つ時間が 5 秒以内になる |
| SC-005 | 典型的な 1 プラグインの PR で、結果が PR に付くまでの時間は、整理前に pre-push で待っていた時間の 2 倍以内に収まる |
| SC-006 | 役割の表で、置き場の無い検証が 0 件。理由なく置き場が 2 つある検証も 0 件 |
| SC-007 | リリースが、手元の環境を使わずにランナーだけで終わる。人の直接 push が `main` に載る件数は 0 件 |
| SC-008 | 配布物に届く依存の更新のうち、次のリリースの CHANGELOG に載らないものが 0 件 |

## Assumptions

- 検証の基盤は GitHub Actions とする。リポジトリは public なので、標準のランナーの利用に費用はかからない
- CI の環境は、手元と同じ `.devcontainer/devcontainer.json` から作る。その都度ビルドするか、作ったイメージを再利用するかは plan で決める
- 自動マージの対象は、dependabot.yml の既存の groups（`*-minor-patch`）の PR と、単独の minor・patch の PR とする。major は対象外
- リリースの actor の身元（専用の GitHub App のトークンか、ほかの手段か）は plan で決める。既定の `GITHUB_TOKEN` は bypass に載せられない場合があり、その push では後続の workflow も起動しない
- npm への publish（`publish-npm.yml`）の trusted publishing は今のまま使う。リリースの workflow から続けて起動するかは plan で決める
- 配布物（スキル）のうち、w-release はリリースの起動手順が変わるので書き直す
- w-release 以外の配布物（スキル・テンプレート）の挙動は、この Epic では変えない
