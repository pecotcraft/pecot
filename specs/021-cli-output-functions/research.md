# Research: CLI の出力を共通の関数だけが書き、行の形がコマンドによらずそろう

spec の Clarifications（2026-11-09）で決めた 4 点を前提にする。英語にそろえること、`--help` も英語にすること、前置きと英文の行の形、データだけを stdout に出すことだ。

## 調べた現状

| 対象 | 現状 | 数 |
|---|---|---|
| Python の CLI の直接の出力 | `cli/commands/` の `typer.echo`。多い順に pr 151・project 141・issue 141・release 73・worktree 47・repo 47 | 675 か所。うち `err=True` は 247 か所 |
| Python の CLI の help の文言 | `help="..."` に日本語を含むもの 118 か所。コマンドの docstring も help に出る | 118 か所 + docstring |
| pytest の出力の確かめ | `result.output`・`result.stdout`・`result.stderr` と比べる行 | 753 + 112 行 |
| parity の golden | `cli-node/tests/parity/golden/<id>.json`。キーは `stdout`・`stderr`・`exitCode`・`requests`・`files` | 224 件 |
| `cli-node/` の直接の出力 | `src/cli.ts` ほか | 4 か所 |
| pecot-visual の直接の出力 | `process.stderr.write` と、注入した `stderr.write`。domain 層にも 2 ファイルある | 約 14 か所 |
| pecot-tools の直接の出力 | `src/cli.ts`・`src/mcp/serve.ts` | 4 か所 |
| pecot-workflow の hooks の日本語の行 | コメントを除く | 105 行 |
| pecot-visual の hooks の日本語の行 | eslint・references・layout の確認の結果が多い | 112 行 |
| Actions のワークフロー | `security sync`・`dependabot sync` を動かすだけで、出力の文字列は読まない | 依存 0 |
| hooks・スキルが CLI の出力の文字列で判定する箇所 | grep では見つからない。移す PR ごとに確かめる | 0 |

## R1. 行の形

- Decision: 小文字の固定の前置き・コロン・空白・英文の 1 行にする。行の種類と形は [contracts/output-lines.md](contracts/output-lines.md) で決める
- Rationale: git・cargo・rustc・gcc と同じ形で、エージェントが最も読み慣れている。前置きで行の種類を確実に見分けられる
- Alternatives considered: logfmt と JSON Lines は、サーバのログの形式で CLI では少ない。clarify で退けた

## R2. 結果の行と予定の行を 1 つの「操作」から作る

- Decision: コマンドは「操作」（動詞と対象）を 1 つ作り、実行の前に `planned(操作)` を、実行の後に `done(操作)` を呼ぶ。dry-run なら前者だけが行を出し、dry-run でなければ後者だけが行を出す
- Rationale: 予定の行と結果の行の語順が、同じ値から作られるので必ずそろう。dry-run でない実行で予定の行が出ないことは、関数の作りで決まる（FR-003）
- Alternatives considered: 予定と結果に別々の文字列を渡す形は、今の `dependabot sync` と同じずれを再び起こせる

## R3. 動詞は閉じた一覧にする

- Decision: 操作の動詞は列挙型で持つ。各動詞は現在形（予定の行）と過去分詞（結果の行の前置き）の組で持つ。初めの一覧は `create`・`update`・`delete`・`add`・`remove`・`close`・`merge`・`move`・`set`・`skip` と、変化なしを表す `unchanged`
- Rationale: 結果の行の前置きが決まった語だけになり、エージェントは前置きの一覧で行を読み分けられる
- Alternatives considered: 動詞を自由な文字列で渡すと、`Updated`・`updated`・`rewrote` のような揺れが残る

## R4. 進捗の行は出さない

- Decision: `プロジェクト情報を取得中...` のような進捗の行は消す。処理の結果として意味のあるものは、結果の行か件数の行に置き換える。例は `deleted: 2 archived items`
- Rationale: 読むのはエージェントだけで、進捗の行は次の手を決める材料にならない（spec の Clarifications）
- Alternatives considered: `note:` で残す形は、行が増えるだけで読む人がいない

## R5. 未設定の値

- Decision: 件数の行の値が未設定（`None`・`null`・`undefined`）なら `unknown` と出す。件数の行の名前は呼ぶ側が英語で渡し、API のフィールド名は使わない
- Rationale: FR-004。未設定を表す語を 1 つに決める

## R6. 共通の関数の置き場所

| CLI | 置き場所 | 層 |
|---|---|---|
| pecot-workflow（Python） | `plugins/pecot-workflow/cli/commands/_output.py` | プレゼンテーション層。`_tracker_sync.py` と同じく、`_` で始まる共有モジュールにする |
| pecot-workflow（Node） | `plugins/pecot-workflow/cli-node/src/commands/output.ts` | プレゼンテーション層 |
| pecot-visual | `plugins/pecot-visual/cli/src/diagnostics.ts` | domain 層は、出力先を受け取るインターフェースだけを持つ。今の `Logger` と同じ形 |
| pecot-tools | `plugins/pecot-tools/cli/src/diagnostics.ts` | 同上 |

- Decision: 3 プラグインがそれぞれ小さなモジュールを持つ。共有のライブラリ（`libs/`）は作らない
- Rationale: 各プラグインは単体で配布する。共有のライブラリを作ると、nx project・release group・同梱の仕組みが増える。モジュールは 50 行ほどで、行の形は契約の文書と、各プラグインのテストの期待値でそろえる（憲章 IV）
- Alternatives considered: `libs/cli-output` を作り、pecot-visual と同じく同梱する形。同梱の仕組みが pecot-tools と pecot-workflow に無いので、今は割に合わない

## R7. Python と Node の一致の確かめ方

- Decision: 行の種類と入力と期待の行の組を、1 つの JSON（`plugins/pecot-workflow/cli-node/tests/output/cases.json`）に置く。pytest と vitest の両方がこれを読み、それぞれの共通の関数の出力と比べる
- Rationale: FR-009。期待の行が 1 か所にあるので、片方だけを変えるとどちらかのテストが落ちる
- pecot-visual・pecot-tools: 各プラグインが自分の期待の行のファイルを持つ。他のプラグインのファイルを読むと、nx の入力に入らず、変えても該当レーンが動かないため。3 つの error・warning・note の行が同じことは、root の `.githooks/tests/` のテストで確かめる
- Alternatives considered: parity の golden だけで確かめる形。Node のコマンドが未登録なので、今は比べる相手が無い

## R8. 直接の出力を止める lint

| CLI | 設定 | 対象から外すファイル |
|---|---|---|
| Python | ruff の `T20`（`print`・`pprint`）と、`TID251` の banned-api（`typer.echo`・`typer.secho`・`click.echo`・`sys.stdout`・`sys.stderr`・`rich.print`） | `cli/commands/_output.py`、`cli/tests/` |
| Node（3 つ） | `no-console`、`no-restricted-syntax`（`stdout`・`stderr` という名前の識別子・プロパティへの `.write` 呼び出し。`process.stdout.write` も含む） | 共通の関数のファイル、pecot-tools と pecot-visual の `mcp/serve.ts` の stdout のガード、テスト |

- Decision: Python と `cli-node/` の lint は、全コマンドを移した後の 1 つの PR で有効にする。pecot-visual・pecot-tools は、診断行を移す PR で有効にする
- Rationale: 有効にした時点で違反が 0 でないと、pre-commit が全ファイルで止まる
- Alternatives considered: 最初から有効にし、未移行のファイルを除外の一覧へ並べる形。除外の一覧と移行の進み具合を、二重で持つことになる
- Alternatives considered: `no-restricted-properties` で `process.stdout.write` を止める形。この規則は `識別子.プロパティ` の 1 段だけを見るので、2 段の `process.stdout.write` に当たらない

## R9. 英語の文言を機械で確かめる

- Decision: 3 つのテストを足す
  - Python: `cli/commands/` の文字列リテラル（f-string の固定部分と docstring を含む）に日本語の文字が無いことを、ast で確かめるテスト
  - Node: `cli-node/`・pecot-visual・pecot-tools の `src/` の文字列リテラルに日本語の文字が無いことを、同じ考えで確かめるテスト
  - hooks: `hooks/**/*.sh` のコメントでない行に、日本語の文字が無いことを確かめるテスト。pecot-workflow は pytest、pecot-visual は `*.test.sh` で書く
- Rationale: SC-007。埋め込む値（Issue のタイトルなど GitHub から読んだもの）は日本語でもよいので、出力の行ではなくコードの固定部分を調べる
- Alternatives considered: 出力の行を調べる形は、Issue のタイトルが日本語のときに誤って落ちる

## R10. GitHub に書く本文の扱い

- Decision: `cli/templates/` と `cli/core/tracker_body.py` など、GitHub に書く本文は変えない。R9 のテストの対象からも外す
- Rationale: spec の FR-014。人が読むもので、aist-roadmap#119 の基準に従う

## R11. 出力を変える PR の進め方

- Decision: PR はコマンドのグループごとに分ける。各 PR は、そのグループの出力の移し替え・help の英語化・pytest の期待値・該当シナリオの golden の記録し直しを一緒に含む
- Rationale: spec 020 の FR-007（golden は Python を変える PR でだけ記録し直す）。1 PR の差分を、レビューできる量に抑える
- 順序は次のとおり
  1. 共通の関数
  2. Tracker の sync
  3. 全コマンドの help の英語化。help を記録した golden（`global-ok-help*` など）は全グループの説明を含むので、1 つの PR にまとめる
  4. issue・pr・project の順に 1 グループずつ
  5. release・worktree・repo・session・main
  6. Python の lint
  7. pecot-visual・pecot-tools
  8. hooks

## R12. MCP ツールが返す文言

- Decision: pecot-visual・pecot-tools の MCP ツールが返す結果の `message`、エラーの文言、ツールと引数の説明文を英語にする（spec の FR-015）。R9 の Node のテストは、両プラグインの `src/` 全体の文字列リテラルを対象にする
- Rationale: 読むのはエージェントだけで、CLI の出力と `--help` と同じ扱いになる
- 対象外: ツールが読んだファイルの中身など、データとして返すもの
- 進め方: pecot-visual は量が多いので、診断行（段階 8）と MCP の文言（段階 9）を分ける。pecot-tools は 1 つの段階にまとめる
