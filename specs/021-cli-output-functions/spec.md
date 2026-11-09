# Feature Specification: CLI の出力を共通の関数だけが書き、行の形がコマンドによらずそろう

**Feature Branch**: `021-cli-output-functions`

**Created**: 2026-11-09

**Status**: Draft

**Input**: Epic pecotcraft/pecot#185。CLI の出力を行の種類ごとの共通の関数に通し、行の形・語順・dry-run の前置きをその関数だけが決める。

## Clarifications

### Session 2026-11-09

- Q: 3 プラグインの行の言語と前置きをそろえるか → A: 3 つともそろえ、英語にする。pecot-workflow の日本語の行も英語に置き換える（FR-012）
- Q: `--help` の文言も英語にするか → A: CLI が書く出力はすべて英語にする。`--help` も含む。CLI の出力を読むのはエージェントで、人は読まない（FR-012）
- Q: 1 行の形をどう決めるか → A: git や cargo と同じ、小文字の固定の前置きと英文の形にする。例は `warning: ...`・`error: ...`・`dry-run: would update Tracker #179 body`・`updated: Tracker #179 body`。記号（`✔` など）は使わない（FR-002、FR-005）
- Q: 行の種類ごとに stdout と stderr をどう分けるか → A: データだけを stdout に出す。予定・結果・警告・エラー・件数は stderr に出す（FR-013）
- Q: hooks のメッセージと GitHub の本文も、英語にする範囲か → A: hooks がエージェントに返すメッセージは含める。GitHub に書く Issue・PR の本文とコメントは、人が読むので含めない（FR-014）
- Q: pecot-visual・pecot-tools の MCP ツールが結果として返す文言も、英語にするか → A: 含める。ツールの説明文（`description`）も、`--help` と同じ扱いで英語にする（FR-015）

## 背景

CLI の出力を読むのはエージェントだ。スキルの中で CLI を動かし、出力から次の手を決める。Actions の run のログも、調べるときはエージェントが読む。今は行の形をコマンドごとに書いた人が決めており、エージェントは行ごとに読み方を変えている。

| | pecot-workflow（Python の CLI） | pecot-workflow（`cli-node/`） | pecot-visual | pecot-tools |
|---|---|---|---|---|
| 出力の書き方 | `typer.echo` を 675 か所で直接呼ぶ | コマンドの登録の枠だけ。出力の関数は無い | `process.stderr.write` などを直接呼ぶ | 同左 |
| 出力先 | stdout と stderr | — | stdout は MCP の JSON-RPC が専有。行の出力は stderr の診断だけ | 同左 |
| 警告・エラーの前置き | 日本語の `警告:` `エラー:` | — | 英語の `[warn]` `[info]` と `pecotv:` | 英語の `pecot-tools:` |

ずれの例:

- 成功の記号は `✔`（19 か所）と `✓`（15 か所）の 2 種類がある
- dry-run の前置きは `[dry-run]` が 3 ファイル、別の表記が 6 か所
- `pecot dependabot sync` は dry-run でないときも、予定の行と結果の行を出す。例は `Tracker #179 の本文を書き直す` と `書き直した: Tracker #179` で、同じ事柄を逆の語順で 2 回出す
- `pecot dependabot sync` の件数の行に、API の生の語が `検証の結果が null: 0 件` と出る

Node への移行（Epic #42、spec 020）との関係: 利用者の `pecot` の実体は、今も Python の CLI だ。`cli-node/tests/parity/golden/` の 224 件は、Python の出力を正として記録している。spec 020 の FR-007 により、golden は Python を変える PR でだけ、その PR の中で記録し直す。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tracker の sync のログが、1 つの事柄を 1 行で、そろった形で出る (Priority: P1)

Actions で毎時動く `pecot security sync` と `pecot dependabot sync` のログを、エージェントが読んで run の結果を確かめる。dry-run でない実行では、変えた事柄ごとに結果の行が 1 行だけ出る。件数の行は決まった語で書かれ、API の生の語（`null` など）を含まない。dry-run では、同じ事柄が予定の行として、決まった前置きつきで出る。

**Why this priority**: 毎時の run のログは最も多く読まれる出力で、今いちばん形が崩れている。共通の関数の行の種類（予定・結果・件数）を、ここで実物に当てて決められる。

**Independent Test**: 偽の GitHub に対して 2 つの sync を dry-run あり・なしで動かし、出た行を期待の行と比べる。

**Acceptance Scenarios**:

1. **Given** 本文の書き換えが要る Tracker、**When** `pecot dependabot sync` を dry-run なしで動かす、**Then** その Tracker の結果の行だけを 1 行出す。予定の行は出ない
2. **Given** 同じボード、**When** `--dry-run` つきで動かす、**Then** 同じ事柄が予定の行として 1 行出る。前置きと語順は、ほかのコマンドの dry-run の行と同じ
3. **Given** 検証の結果が未設定の PR を含む一覧、**When** 件数の行を出す、**Then** 行に `null` などの API の生の語が出ず、決まった語で書かれる

---

### User Story 2 - pecot-workflow のどのコマンドも、行の種類ごとに同じ形で出す (Priority: P1)

エージェントがスキルの中で pecot-workflow の CLI を動かし、出力を読む。どのコマンドでも、各行は種類ごとに同じ前置き・語順で出る。種類は警告・エラー・結果・予定・件数の 5 つで、記号は使わない。

**Why this priority**: エージェントがコマンドごとに読み方を変えずに済む。Epic の主目的だ。

**Independent Test**: 全サブコマンドの golden を記録し直す。golden の全行を機械で調べ、行の種類ごとの形が 1 つに決まっていることを確かめる。

**Acceptance Scenarios**:

1. **Given** 移行後の CLI、**When** 全サブコマンドの前後比較のシナリオを流す、**Then** 警告・エラーの行の前置きは全コマンドで同じになる。`✔`・`✓` などの記号は出ない
2. **Given** 移行後の CLI、**When** dry-run を持つ全コマンドを `--dry-run` つきで動かす、**Then** 予定の行の前置きは全コマンドで同じになる
3. **Given** Issue の本文・表・JSON などのデータを出すコマンド、**When** 実行する、**Then** データの中身は今と同じで、行の種類の前置きは付かない

---

### User Story 3 - 共通の関数を通らない出力をコードに入れられない (Priority: P2)

コマンドを書く人（人・エージェント）が直接出力するコードを書くと、lint が止める。直接の出力とは `typer.echo`・`print`・`console.error`・`process.stderr.write` などの呼び出しを指す。出力は共通の関数を通すしかない。

**Why this priority**: 移行した後に形がまた崩れないようにする。心がけではなく仕組みで守る。

**Independent Test**: コマンドのコードに直接の出力を 1 行足して lint を動かし、止まることを確かめる。共通の関数の中だけは止まらない。

**Acceptance Scenarios**:

1. **Given** pecot-workflow のコマンドのコード、**When** `typer.echo` を直接呼ぶ行を足す、**Then** lint が失敗し、使うべき共通の関数を示す
2. **Given** pecot-visual・pecot-tools・`cli-node/` のコード、**When** `process.stderr.write` を直接呼ぶ行を足す、**Then** lint が失敗する
3. **Given** 共通の関数の実装そのもの、**When** lint を動かす、**Then** 止まらない

---

### User Story 4 - Node の CLI も同じ行を出す (Priority: P2)

`cli-node/` が、Python と同じ行の種類の関数を持つ。Node に移したコマンドは、parity のテストで Python と同じ行を出すと確かめられる。

**Why this priority**: Epic #42 の移行の後に、そろえた形が崩れないようにする。

**Independent Test**: Node の共通の関数に、Python と同じ入力（行の種類・中身・dry-run の有無）を与え、同じ行が出ることを確かめる。

**Acceptance Scenarios**:

1. **Given** 行の種類と中身の組の一覧、**When** Python と Node の共通の関数にそれぞれ与える、**Then** 出る行が一字一句同じになる
2. **Given** 記録し直した golden、**When** parity のテストを流す、**Then** Python の CLI が golden と一致する

---

### User Story 5 - pecot-visual と pecot-tools の診断行もそろう (Priority: P3)

pecot-visual と pecot-tools の stderr の診断行（警告・情報・エラー）が、それぞれの CLI の共通の関数を通る。MCP のツールの結果に入る stderr の文字列も、同じ形になる。

**Why this priority**: 行の出力が stderr の診断に限られ、量が少ない。pecot-workflow の形を決めた後に合わせる。

**Independent Test**: 警告を出す既存の処理（アイコンが見つからない、PNG の生成の失敗など）を動かし、診断行が共通の関数の形で出ることを確かめる。

**Acceptance Scenarios**:

1. **Given** PNG の生成に失敗する入力、**When** pecot-visual のツールを動かす、**Then** 結果の stderr に共通の関数の形の警告の行が入る
2. **Given** 起動時に Node の版が下限より古い、**When** pecot-visual・pecot-tools を起動する、**Then** エラーの行が共通の関数の形で stderr に出る
3. **Given** MCP サーバとして動いている、**When** 診断行を出す、**Then** stdout の JSON-RPC に診断行が入らない
4. **Given** 実行時依存が未取得の環境、**When** pecot-visual のツールを呼ぶ、**Then** 結果の `message` は英語で返る
5. **Given** MCP クライアント、**When** ツールの一覧を取る、**Then** 各ツールの説明文と引数の説明は英語で返る

---

### Edge Cases

- 1 つのコマンドが同じ事柄について予定と結果の両方を出そうとしたら、dry-run でないときは結果だけが出る。コマンドの側で出し分けを書かない
- 件数の行に渡す値が未設定（`null`・`None`・`undefined`）なら、共通の関数はそれを生の語のまま出さない。未設定を表す決まった語を出す
- 行の中身が複数行の文字列なら、2 行目以降も同じ行の種類だと読める形で出す
- stdout が端末でない（Actions のログ、パイプ）ときも、前置きと文言は同じにする
- dry-run の行とエラーの行を両方出すコマンドでは、エラーの行に dry-run の前置きを付けない
- Issue の本文・JSON など、データとして他のプログラムが読む出力は、行の種類の前置きで壊さない
- hooks のガードやスキルが今の出力の文字列（`エラー:` など）で判定していたら、出力を変えると判定が外れる

## Requirements *(mandatory)*

### Functional Requirements

| ID | 要件 |
|---|---|
| FR-001 | 各 CLI は、行の種類ごとに出力する共通の関数を持つ。対象の CLI は pecot-workflow の Python と `cli-node/`、pecot-visual、pecot-tools の 4 つ。行の種類は、予定・結果・警告・エラー・件数・注記と、データ（本文・表・JSON をそのまま出すもの）とする。注記は pecot-visual・pecot-tools の情報の診断だけに使う |
| FR-002 | 行の前置き・語順・dry-run の前置き・出力先（stdout か stderr か）は、共通の関数だけが決める。コマンドのコードは行の種類と中身だけを渡す。行の形は、小文字の固定の前置き・コロン・空白・英文とする（例: `warning: ...`、`dry-run: would update Tracker #179 body`） |
| FR-003 | 予定の行は dry-run のときだけ出す。dry-run でないときの予定の行の呼び出しは、何も出さない。これは共通の関数の作りで決まり、コマンドの側の分岐に頼らない |
| FR-004 | 件数の行は、値が未設定のとき API の生の語（`null`・`None`・`undefined`）を出さない。項目の名前にも API のフィールド名をそのまま使わず、決まった語で書く |
| FR-005 | 行に記号（`✔`・`✓` など）を使わない。成功は結果の行の前置きで表す |
| FR-006 | pecot-workflow の Python の CLI のコマンドのコードにある直接の出力（675 か所）を、すべて共通の関数に移す |
| FR-007 | lint は、共通の関数の外で直接出力するコードを止める。対象は Python の `typer.echo`・`print`・`sys.stdout`/`sys.stderr` への書き込みと、Node の `console.*`・`process.stdout.write`・`process.stderr.write`。共通の関数の実装と、テストのコードは対象から外す |
| FR-008 | Python の出力を変える PR は、同じ PR で該当シナリオの parity の golden を記録し直す（spec 020 の FR-007 に従う） |
| FR-009 | Node の共通の関数は、同じ入力に対して Python の共通の関数と一字一句同じ行を出す。これをテストで確かめる |
| FR-010 | pecot-visual と pecot-tools の診断行は stderr にだけ出し、stdout の JSON-RPC に入れない。MCP のツールの結果に入る stderr の文字列も、共通の関数を通った行にする |
| FR-011 | 出力の文字列で判定している hooks・スキル・テンプレート・テストは、出力を変える PR で一緒に直す |
| FR-012 | 3 プラグインの CLI が書く出力は、すべて英語にする。前置き・行の文言・`--help` の文言（コマンドと引数の説明）を含む。行の種類ごとの前置きは 3 プラグインで同じにする。pecot-workflow の日本語の出力は英語に置き換える。CLI が組み立てる見出しと項目名（`project info` の `ロードマップリポ` など）も英語にする。GitHub から読んだ Issue の本文など、データの中身は対象外 |
| FR-013 | データ（本文・表・JSON）だけを stdout に出す。予定・結果・警告・エラー・件数の行は stderr に出す。pecot-visual・pecot-tools も同じ分け方で、stdout は MCP の JSON-RPC だけが使う |
| FR-014 | pecot-workflow と pecot-visual の hooks がエージェントに返すメッセージ（拒否の理由・警告など）も英語にし、CLI と同じ行の種類の前置きを使う。GitHub に書く Issue・PR の本文とコメント（`cli/templates/` など）は対象外とし、今の基準（aist-roadmap#119）に従う |
| FR-015 | pecot-visual・pecot-tools の MCP ツールが返す文言は、すべて英語にする。結果の `message`・エラーの文言・ツールと引数の説明文（`description`）を含む。ファイルの中身など、ツールが読んだデータは対象外 |

### Key Entities

| 名前 | 説明 |
|---|---|
| 行の種類 | 予定・結果・警告・エラー・件数・注記・データ。種類ごとに前置き・出力先・dry-run での扱いが決まる |
| 共通の関数 | 行の種類ごとに出力する関数。各 CLI に 1 組ずつある。Python と Node は同じ入力で同じ行を出す |
| parity の golden | Python の CLI の出力を正として記録したもの。出力を変える PR で記録し直す |

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | 基準 |
|---|---|
| SC-001 | pecot-workflow の Python の CLI のコマンドのコードで、共通の関数を通らない直接の出力が 0 か所になる（今は 675 か所） |
| SC-002 | 記録し直した golden の全行で、`✔`・`✓` などの記号が 0 個になる。dry-run・警告・エラーの前置きは、それぞれ 1 種類だけが出る |
| SC-003 | dry-run でない `security sync`・`dependabot sync` のログで、予定の行と API の生の語を含む行が、どちらも 0 行になる |
| SC-004 | 直接の出力を 1 行足した変更は、4 つの CLI のどれでも lint で止まる |
| SC-005 | Python と Node の共通の関数に同じ入力を与えたテストが、行の種類のすべてで一致する |
| SC-006 | pecot-visual・pecot-tools の stderr の診断行で、共通の関数を通らないものが 0 か所になる |
| SC-007 | 記録し直した golden・3 プラグインの診断行・MCP ツールの結果と説明文・hooks がエージェントに返すメッセージで、CLI と hooks のコードが書く固定の文言に日本語が 0 文字になる。`--help` の文言も数える。GitHub から読んで埋め込んだ値は数えない |

## Assumptions

| 前提 | 内容 |
|---|---|
| 移行の対象 | 今の `pecot` の実体の Python の CLI を移す。`cli-node/` はコマンドが未登録なので、共通の関数とそのテストを足すだけにする。コマンドの移行は Epic #42 で行う |
| データの出力 | データは、GitHub やファイルから読んだ値を指す。`issue read` の本文や表の値は変えず、行の種類の前置きを付けない。表の見出しなど CLI が組み立てる文言は FR-012 で英語にする |
| typer の表示 | `--help` と使い方エラーの枠と書式は typer のまま残す。中の文言（コマンドと引数の説明）は FR-012 で英語にする |
| 起動スクリプト | `bin/pecot` など shell の起動スクリプトの準備の行は、CLI の本体の外なので対象外とする |
| 終了コード | 変えない |
| GitHub の本文 | CLI が GitHub に書く Issue・PR の本文とコメントは、人が読むので日本語のまま残す |
| 出力を読むスキル | 出力の文字列を読むのは同梱のスキルだけなので、出力を変える同じ PR で直せる |
