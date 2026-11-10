# Research: CLI と MCP のインタフェース定義書を正として持ち、テストを振る舞いの資料として読める

spec の Clarifications（2026-11-10）の 3 点を前提にする。今の pytest につなぐこと、機械的に取れる項目を実装から書き出すこと、振る舞いの項目の文とテスト名だけを日本語にすることだ。
項目とテストをつなぐツールは、#200 で sphinx-needs に決めてある。

## 調べた現状

| 対象 | 現状 | 数 |
|---|---|---|
| pecot-workflow の CLI のコマンド | `cli/commands/main.py` が typer の app に登録する。`typer.main.get_command(app)` の木から、名前・説明・引数の属性を取れる（手元で確かめた） | 34 |
| pecot-tools の MCP ツール | `cli/src/mcp/tools/` の zod の定義。`tools/list` が JSON Schema で返す | 26 |
| pecot-visual の MCP ツール | 同上 | 約 10 |
| pecot-workflow の Node の登録の枠 | `cli-node/src/commands/registry.ts` の `CommandSpec`。入力は zod で、CLI と MCP の両方がここから作られる。登録済みのコマンドは無い | 0 |
| 手で写した契約の表 | pecot-tools の `src/mcp/tests/contract.test.ts` の `TOOL_CONTRACTS`。別リポの契約からの転記 | 1 |
| w-help の `commands.md` | 手書き。コマンドと 1 行の説明の表 | 77 行 |
| vitest の `it.each`・`describe.each` | pecot-tools 36、pecot-visual 96、`cli-node/` 107、text-rules 29 | 268 か所 |
| テスト名の lint | `@vitest/eslint-plugin` は 4 つの project に入っている。題の形を決める規則は無効 | 0 |
| JUnit の出力 | pecot-workflow の pytest は `--junitxml` を使っている。vitest は出していない | — |

## R1. 定義書の形式

- Decision: 自前の形式にする。引数は JSON Schema（2020-12）の object で書き、MCP の `inputSchema` と同じ形にそろえる。項目名は [contracts/definition-format.md](contracts/definition-format.md) で決める
- Rationale: 実装から書き出す型と既定値、人が書く副作用の相手と振る舞いの項目、MCP ツールの 3 つを、1 つの形式で持てるのはこれだけだった
- Alternatives considered:

| 候補 | 現状（2026-11-10） | 採らない理由 |
|---|---|---|
| OpenCLI | 0.1 の draft。release が無い | 引数の型と既定値の項目が無い。拡張は `metadata` だけで、MCP ツールを表す決めも無い |
| usage spec（KDL） | v7.3.0。3 か月で major が 4 回上がった | 知らないキーが parse error になり、副作用の相手・前提・振る舞いの項目を置けない。MCP ツールを表せない |
| MCP の `tools/list` の形だけ | 安定 | CLI のコマンドの木と終了コードを表せない。引数の部分にだけ使う |

usage spec の語（`effect` の read・write・destructive、`exit_code`、`conflicts`・`requires`）は、自前の項目名に借りる。

## R2. 定義書を 2 つのファイルに分ける

- Decision: 定義書はプラグインごとの `interface/` に、書き出すファイルと人が書くファイルを分けて置く

| ファイル | 書き手 | 中身 |
|---|---|---|
| `interface/generated.json` | 書き出しのコマンド | 項目の ID・名前・説明・引数の JSON Schema・公開面（CLI のパス、MCP ツールの名前） |
| `interface/authored.yaml` | 人・エージェント | 項目の ID ごとに、実装から取れない欄と、振る舞いの項目。欄の一覧は R12 にある |

- Rationale: 書き出しが人の書いた欄に触れないので、FR-021 が作りで守られる。YAML のコメントを保ったまま書き戻す処理も要らない
- Alternatives considered: 1 つの YAML に書き出しを書き戻す案は、書き戻しの処理が要り、書き損じたときに人の書いた欄を失う
- 2 つのファイルの項目の ID の集合が同じことを、形式の検証が確かめる。実装にコマンドを足して書き出すと、`authored.yaml` に項目が無いので止まる

## R3. 実装からの書き出し

- Decision: 書き出しは、公開面を実際に組み立てた結果から取る

| プラグイン | 取り出す元 | 書き出しを置く場所 |
|---|---|---|
| pecot-workflow（今） | `typer.main.get_command(app)` の木。コマンドの `help`・`hidden` と、引数の `name`・`opts`・`type`・`required`・`default`・`multiple`・`help` | `scripts/interface/export.py` |
| pecot-workflow（#42 の後） | `registry.ts` の `CommandSpec`。入力の zod を `z.toJSONSchema()` に通す | `cli-node/scripts/` |
| pecot-tools・pecot-visual | メモリ内でつないだ MCP サーバの `tools/list` | 各 `cli/scripts/` |

- Rationale: 利用者に見える形と同じものが定義書に入る。`z.toJSONSchema()` が型・必須・既定値・許可値を出すことは、zod 4.6.7 で確かめた
- 確かめた制約: typer 0.28.0 は click を内部に同梱しており、Click の `to_info_dict()` は無い。属性を直接たどる。同梱の click の非公開のモジュールは import しない
- 一致の確認: 各プラグインのテストが、書き出し直したものとリポジトリの `generated.json` を比べる。食い違った項目の ID と欄を出す。直すコマンドは同じスクリプトの `--write` だ

## R4. 共有のコードの置き場

- Decision: 新しい nx の project `libs/interface-spec` を作る。形式の定義（zod）・読み込みと検証・`commands.md` の生成・つなぎの確認・表示の sphinx を置く。release の group には入れず、配布しない
- Rationale: 3 プラグインが同じ形式と同じ確認を使う。プラグインごとに写すと、形式が食い違う
- Alternatives considered: `.githooks/scripts/` に置く案は、vitest と eslint の設定を持てない

## R5. 項目とテストのつなぎ方

- Decision: テストは、確かめる振る舞いの項目の ID を、文字列のリテラルで書く

| テスト | 書き方 | JUnit に出る形 |
|---|---|---|
| vitest | `it('…', async (ctx) => { await verifies(ctx, 'PT-AWS-S3-LS-01') … })`。`verifies` は `annotate(id, 'verifies')` を呼ぶ 1 行の関数 | `<property name="verifies">` |
| pytest | `@add_test_properties(verifies=["PW-ISSUE-CREATE-01"])`（ub-test-reports） | 同上 |

- ID の形は `<プラグインの接頭辞>-<コマンドかツールの名前>-<2 桁の番号>` とする。接頭辞は `PW`・`PT`・`PV` だ
- 確かめた制約（#200）: vitest の `it.each` は `annotate` を使えないので、つなぐテストは `it.for` に書き換える。pytest は `junit_family=xunit1` で動かす
- 全ツールに共通の振る舞い（入力の検証の形など）は、ツールごとの項目にしない。プラグインの共通の項目（`PT-COMMON-01` など）に書き、表を回すテスト 1 件からつなぐ

## R6. テストの無い項目と、存在しない ID を止める場所

- Decision: テストのソースを読む静的な確認で止める。テストのファイルから ID の形の文字列を集め、定義書の ID と比べる

| 見つけるもの | 止め方 |
|---|---|
| 定義書に無い ID を書いたテスト | 失敗し、ファイルと行を示す |
| どのテストにも書かれていない振る舞いの項目 | 失敗し、項目の ID を示す |

- Rationale: CI は変更が届いたレーンだけを動かす。PR の run には全プラグインのテストの結果がそろわないので、結果から網羅を判定すると、動かなかったレーンの項目がすべて「テスト無し」になる。静的な確認は、テストを動かさずに数秒で終わる
- Alternatives considered: sphinx-needs の `back_links` の `minItems` は、#200 で止められると確かめた。ただし、全レーンの JUnit がそろう実行でしか正しく判定できない。表示の側には使わない
- 静的な確認は「ID が書かれている」ことまでを見る。テストが実際にその ID を JUnit に出したかは、表示の `-W` のビルドが見る

## R7. 表示と振る舞いの一覧

- Decision: sphinx-needs で 1 つの HTML を作る。定義書を直接読む自作のディレクティブが、`sphinx_needs.api.create_need` で need を作る

| need の型 | 元 | 中身 |
|---|---|---|
| コマンド・ツール | 定義書の項目 | 説明と、引数・副作用・終了コードの表 |
| 振る舞いの項目 | `authored.yaml` の `behaviors` | 日本語の 1 文。コマンド・ツールへ `belongs` でつなぐ |
| テストのケース | JUnit（sphinx-test-reports） | 名前と合否。項目へ `verifies` でつなぐ |

- Rationale: 中間のファイル（needs.json・生成した .rst）を持たずに済む。`create_need` は 9.x で公開の API だ。試行で、つなぎ・needtable・引数の表が出ることを確かめた（`.pecot/work/199/tech-advisor/A-directive/`）
- Alternatives considered: `needs_external_needs` は、取り込んだ need がページに出ない。`needimport` は needs.json を作るスクリプトが要る
- 確かめた制約:
  - `add_need` は 9.2.0 で非推奨、10.0 で消える。`create_need` を使う
  - sphinx-test-reports 4.0.0 は sphinx-needs 9 系に固定されている
  - テスト 5,000 件を 1 ページに描くと HTML が 23.5 MB になる。プラグインごとにページを分け、テストのケースは項目につないだものだけを描く
  - suite が多いと ID が衝突する。`tr_suite_id_length`・`tr_case_id_length` を 8 にする
  - 全量のビルドは、項目 500・テスト 5,000 で約 20 秒だった
- JUnit の無いプラグインは、項目の合否を「未実行」と出す。失敗したテストで CI を落とすのは、今のテストのレーンが担う

## R8. `commands.md` の生成と鮮度

- Decision: `libs/interface-spec` のコマンドが、`generated.json` から `skills/w-help/references/commands.md` を書く。先頭に、生成物であることと直し方を 1 行で書く。lint のレーンが、作り直したものとリポジトリのものを比べる
- Rationale: 配布するのは生成済みのファイルで、利用環境で生成の処理は動かない
- グループの見出しと並びは、定義書のコマンドのパスの 1 段目から作る

## R9. テスト名の規約と lint

- Decision: 規約は `.claude/rules/test-conventions.md` に置く。中身は [contracts/test-conventions.md](contracts/test-conventions.md) で決める
- lint は、vitest の題に `vitest/valid-title` を使う。規約の対象のファイルは、eslint の設定に glob で書く
- pytest は名前を直さず、lint の対象にしない（spec の Assumptions）。項目の ID のデコレータだけを足す
- 確かめる点: `vitest/valid-title` の `mustMatch`・`mustNotMatch` が、`describe` と `it` を分けて指定できるか。実装のタスクの最初に確かめる

## R10. nx のレーン

| レーン | 中身 | 入力 |
|---|---|---|
| `interface-spec:test-unit` | 形式の検証・生成・つなぎの確認の単体テスト | `libs/interface-spec/**` |
| `interface-spec:lint` | eslint と tsc | 同上 |
| `interface-spec:lint-defs` | 3 プラグインの定義書の形式の検証、つなぎの静的な確認、`commands.md` の鮮度 | 各 `interface/**`、テストのファイル、`commands.md` |
| 各プラグインの既存の `test-py`・`test-cli` | 書き出し直したものと `generated.json` の一致 | 既存の入力に `interface/**` を足す |
| `interface-spec:docs` | 表示の HTML を作る。PR の必須のレーンにしない | 定義書と JUnit |

- 新しいレーン名は、lint と test の hook の列挙に足す（`.githooks/README.md` R1）
- `interface-spec` は release の group に入れない。version plan の確認が、この project の変更で plan を求めないことを確かめる

## R11. 開発にだけ要る Python のパッケージ

- Decision: sphinx-needs・sphinx-test-reports の版は、`libs/interface-spec/docs/` の `uv.lock` で固定する
- pecot-workflow の pytest には、ub-test-reports を dev 依存で足す
- Rationale: devcontainer と CI のイメージに uv がある。利用者の環境には入らない
- #42 で pecot-workflow の Python が消えた後も、表示を作る Python は開発環境に残る

## R12. 定義書に書く欄を、確立した枠組みに照らして決める

- Decision: 欄の選び方を、次の枠組みに照らす。対応の表は [contracts/definition-format.md](contracts/definition-format.md) に置く

| 決めること | 従う枠組み | 版・公開元 | 読めた範囲 |
|---|---|---|---|
| 1 コマンド・1 ツールに書く節 | POSIX のユーティリティ記述の節立て（Utility Description Defaults） | IEEE Std 1003.1-2024、The Open Group | 全文 |
| 書くものと書かないもの | Diátaxis のリファレンス | diataxis.fr | 全文 |
| 副作用と冪等の分け方 | MCP の Tool の annotations | MCP 仕様 2026-07-28 | 全文 |
| 前提の書き方 | 設計契約の事前条件 | eiffel.com | 全文 |
| 振る舞いの項目の文の型 | EARS | Mavin ほか、2009 | 全文 |
| テストとのつなぎ | 要件とテストの双方向の追跡と網羅 | ISO/IEC/IEEE 29119-3:2021、Automotive SPICE 4.0 の SWE.6 | 目次と二次資料だけ |

- Rationale: 何を書けば足りるかを、このリポの判断だけで決めると、欄の過不足を評価できない。POSIX は、CLI に書く節と各節の趣旨を規範として定めていて、無料で読める
- POSIX に当てて見つかった欠け: 出力の形（STDOUT）、診断の出力（STDERR）、標準入力（STDIN）、環境変数、失敗の後に残る状態（CONSEQUENCES OF ERRORS）。MCP と clig.dev に当てて見つかった欠けは、冪等性と非推奨の 2 つだ
- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| Gherkin（Given-When-Then） | 複数行のシナリオの形で、1 文の項目に合わない。200〜300 項目には重い |
| man-pages(7) の節の慣例 | POSIX より節が少なく、各節の趣旨が規範の文になっていない |
| arc42 のインタフェースの記述 | 相手とチャネルの文脈の図で、コマンドの粒度に合わない |
| ISO/IEC/IEEE 29148 と INCOSE の要件の書き方 | 文の型ではなく、良い要件の観点（単一・確かめられる・あいまいな語が無い）だ。本文を読めていない。観点だけを 1 文 1 要件の決めに借りる |

- 確かめた制約:
  - POSIX は CLI が前提だ。MCP ツールでの読み替え（終了の状態を失敗の種別に、標準出力を結果の構造に）は、このリポの決めになる
  - 有料の規格は本文を読めていない。準拠は名乗らない
  - EARS は英語の語順が前提で、標準の日本語の文型は見つからなかった。日本語の形は、このリポの規約として決める
  - つなぎの確認は ID の有無だけを見る。テストが項目の中身を確かめていることまでは示せない
- 書く量: 人の書く欄が 7 つ増える。MCP ツールの出力の形と annotations は書き出しに寄せ、環境変数はソースの文字列と比べて保つ

## R13. 定義書を OpenRPC に載せるか

- Decision: 載せない。R1 の形式のまま、欄を R12 の枠組みに対応づける
- Rationale: 欄の過不足は R12 の枠組みで評価できる。OpenRPC に載せて得られるのは、公開の meta-schema での検証と `x-` の拡張だが、次の無理がある

| 点 | 中身 |
|---|---|
| 終了の状態の置き場 | `errors` は JSON-RPC のエラーの欄で、終了コードを入れるのは流用になる。`errors` の中には `x-` の拡張を置けない |
| 拡張の中身の検証 | meta-schema は `x-` の中身を見ない。人が書く欄は、結局このリポの定義で検証する |
| 文書の生成 | 生成器の保守が弱く、`x-` の欄を表示するかも確かめられていない。表示は sphinx-needs で作るので、生成器を使わない |

- 確かめたこと（`.pecot/work/199/framework/trial/`）: OpenRPC 1.4.1 の meta-schema は、`x-` を付けた欄を通し、付けない知らない欄を拒む
