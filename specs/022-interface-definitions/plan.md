# Implementation Plan: CLI と MCP のインタフェース定義書を正として持ち、テストを振る舞いの資料として読める

**Branch**: `022-interface-definitions` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/022-interface-definitions/spec.md`

## Summary

3 プラグインの公開面を、プラグインごとの定義書に書く。
公開面は、pecot-workflow の CLI の 34 コマンドと、pecot-tools・pecot-visual の MCP ツール約 36 だ。
定義書は 2 つのファイルに分ける。`generated.json` は実装から書き出し、`authored.yaml` は人が書く。
形式は自前で、引数は JSON Schema で持つ。MCP の `inputSchema` と同じ形になる。
各プラグインのテストが、書き出し直したものと `generated.json` を比べ、食い違いを止める。
人が書く側の欄は、POSIX のユーティリティ記述の節立てに対応づける。出力の形・環境変数・終了の状態・失敗の後に残る状態などだ。
振る舞いの項目は、EARS の型で書いた日本語の 1 文と ID を持つ。
テストは、確かめる振る舞いの項目の ID を書く。テストのソースを読む確認が、テストの無い項目と、定義書に無い ID を止める。
表示は sphinx-needs で作る。定義書を直接読み、JUnit の結果を取り込み、項目ごとのテストと合否を 1 つの HTML に出す。
w-help の `commands.md` は定義書から生成し、古いと lint が止める。
共有のコードは、新しい nx の project `libs/interface-spec` に置く。配布しない。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | TypeScript（`libs/interface-spec` と、MCP ツールの書き出し）、Python 3.10 以上（typer の書き出しと、表示の sphinx の拡張） |
| Primary Dependencies | zod 4.6.7（形式の定義と `z.toJSONSchema()`）、yaml 2.9（`authored.yaml` の読み込み）、typer 0.28、`@modelcontextprotocol/sdk`、sphinx-needs 9.2 と sphinx-test-reports 4.0（表示）、ub-test-reports（pytest の JUnit に ID を出す）、`@vitest/eslint-plugin`（題の lint） |
| Storage | リポジトリのファイル（`plugins/<plugin>/interface/`） |
| Testing | vitest（`libs/interface-spec` と各プラグイン）、pytest（pecot-workflow） |
| Target Platform | devcontainer と GitHub Actions の runner。利用者の環境では何も動かない |
| Project Type | 開発用のライブラリと、各プラグインの定義書 |
| Performance Goals | 形式の検証とつなぎの確認は、テストを動かさずに 10 秒以内に終わる。表示の全量のビルドは 1 分以内に終わる（試行は、項目 500・テスト 5,000 で約 20 秒） |

**Constraints**:

- 既存のコマンド・ツールの振る舞いと終了コードを変えない
- sphinx・ub-test-reports は開発と CI でだけ動かす。配布物と利用者の前提に足さない
- CI は変更が届いたレーンだけを動かす。網羅の判定を、テストの結果に依らせない（research R6）
- pecot-workflow の初版は、PR #227 のマージ後の main から書き出す
- typer が同梱する click の非公開のモジュールを import しない（research R3）
- ルート直下にディレクトリを足さない。新しい project は `libs/` に置く

**Scale/Scope**:

- 定義書の項目 約 70（pecot-workflow 34、pecot-tools 26、pecot-visual 約 10）
- 人が書く欄 約 70 項目分（1 項目あたり 14 欄）と、振る舞いの項目（1 項目あたり 2〜5 個の見込みで、計 200〜300 個）
- つなぐテスト: pytest 約 2,100 件と vitest 約 3,400 件のうち、振る舞いの項目を確かめるもの
- `it.each` から `it.for` への書き換え: つなぐテストに限る（全体は 268 か所）
- 規約の lint の対象: 4 つの project の vitest

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | `libs/interface-spec` は、形式と検証（domain）・ファイルの読み書き（infra）・コマンド（cli）に分ける。各プラグインの書き出しは、公開面を組み立てた結果を読むだけで、domain 層に手を入れない。層の依存は既存の `import-x/no-restricted-paths` と同じ設定で確かめる |
| II. TDD | 合格 | 形式の検証・一致の確認・つなぎの確認・環境変数の確認・eslint の規則・sphinx の拡張は、失敗する入力（欄の欠け・古い書き出し・無い ID など）のテストを先に書く。期待は、失敗の行の文字列と比べる。モックはファイルの読み書きだけにする |
| III. コード品質 | 合格 | 一致の確認・形式の検証・つなぎの確認・題の lint を、nx のレーンに載せる。新しい project にも eslint・tsc・カバレッジの閾値を置く。新しい Python のコード（typer の書き出し、sphinx の拡張）は、ruff と strict の型チェックの対象に入れてから書く |
| IV. YAGNI | 条件つき合格 | 新しい project と Python の表示を足す。理由は Complexity Tracking に書く。欄は POSIX の節に対応するものに限り、全項目が既定の扱いになる節（ASYNCHRONOUS EVENTS）と CHANGE HISTORY は欄にしない。定義書から実装を生成する仕組み、Web への公開、OpenRPC・usage spec への書き出しは作らない |
| V. 本体優先 | 合格 | speckit 成果物は新規の一式だけを作る。spec 020 の契約は、定義書を正とする 1 行を足すだけにする（FR-018） |

Phase 1 の設計の後も、同じ判定になる。

## Project Structure

### Documentation (this feature)

```text
specs/022-interface-definitions/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── definition-format.md
│   └── test-conventions.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
libs/interface-spec/                 # 新規の nx project。配布しない
├── project.json                     # test-unit・lint・lint-defs・docs
├── src/
│   ├── domain/                      # 形式の定義（zod）、検証、差分、ID の規則、枠組みとの対応表
│   ├── infra/                       # 定義書とテストのファイルの読み込み
│   └── cli.ts                       # validate・links・commands-md の 3 つのコマンド
├── tests/
└── docs/                            # 表示（sphinx）
    ├── pyproject.toml・uv.lock      # sphinx-needs・sphinx-test-reports の版
    ├── conf.py
    ├── _ext/iface_defs.py           # 定義書を読んで need を作るディレクティブ
    └── index.rst ほか               # プラグインごとのページ

plugins/pecot-workflow/
├── interface/
│   ├── generated.json               # 新規。書き出し
│   └── authored.yaml                # 新規。人が書く
├── scripts/interface/export.py      # 新規。typer の木から書き出す（--check・--write）
├── cli/tests/unit/test_interface_export.py  # 新規。書き出しと generated.json の一致
├── cli/tests/                       # 振る舞いの項目の ID を足す。名前は直さない
├── cli/pyproject.toml               # ub-test-reports を dev 依存に足す
├── skills/w-help/references/commands.md     # 生成物に変える
└── project.json                     # test-py の入力に interface/ を足す

plugins/pecot-tools/
├── interface/{generated.json,authored.yaml}
├── cli/scripts/export-interface.ts  # 新規。tools/list から書き出す
├── cli/src/mcp/tests/contract.test.ts       # TOOL_CONTRACTS の表を、定義書との一致に置き換える
├── cli/tests/_helpers/verifies.ts   # 新規。annotate を呼ぶ 1 行の関数
├── cli/vitest.config.ts             # JUnit を出す
└── cli/eslint.config.js             # 題の lint

plugins/pecot-visual/                # pecot-tools と同じ形
plugins/pecot-workflow/cli-node/     # 題の lint と verifies の関数。書き出しは、見本の CommandSpec で形だけを確かめる

.claude/rules/test-conventions.md    # 新規。テストの規約
.githooks/                           # レーン名の列挙に interface-spec のレーンを足す
specs/020-workflow-ts-mcp/contracts/mcp-tools.md  # 定義書を正とする 1 行を足す
```

**Structure Decision**: 定義書は、公開面の持ち主である各プラグインの `interface/` に置く。3 プラグインが共有する形式・検証・生成・表示は、`libs/interface-spec` の 1 か所に置く。ルート直下のディレクトリは増やさない。

## 実装の段階と PR

| 段階 | 中身 | 対応 |
|---|---|---|
| 1 | `libs/interface-spec` の骨組み。形式の定義、形式の検証（欄の有無・EARS の型と文の形・annotations との一致・環境変数の名前）、差分の出し方、nx のレーンと hook の列挙 | FR-002・FR-003・FR-007・FR-017・FR-023〜FR-028 |
| 2 | pecot-workflow の書き出しと一致の確認。`generated.json` の初版（PR #227 のマージ後） | US1・FR-006・FR-021 |
| 3 | pecot-workflow の `authored.yaml` のうち、`project` のコマンド。EARS の規則を実物で確かめる | US1・FR-003・FR-004・FR-022・FR-024〜FR-026 |
| 4 | 同じく、`issue` と `pr` のコマンド | US1 |
| 5 | 同じく、残りのコマンド。項目の欠けを止める | US1 |
| 6 | pecot-tools の書き出し・一致の確認・`authored.yaml`。`TOOL_CONTRACTS` の表を置き換える | US2 |
| 7 | pecot-visual の書き出し・一致の確認・`authored.yaml` | US2 |
| 8 | `commands.md` の生成と鮮度の確認 | US3・FR-010・FR-011 |
| 9 | テストの規約を `.claude/rules/` に置き、題の lint を有効にする。外れた題を直す | US4・FR-012〜FR-014 |
| 10 | つなぎの確認を足す。vitest の `verifies` と JUnit の出力、pytest の ub-test-reports | US4・FR-013 |
| 11 | pecot-workflow の振る舞いの項目に pytest をつなぎ、テストの無い項目があれば失敗にする | US5・FR-019 |
| 12 | pecot-tools の振る舞いの項目に vitest をつなぐ | US5・FR-019 |
| 13 | pecot-visual の振る舞いの項目に vitest をつなぐ | US5・FR-019 |
| 14 | 表示の sphinx。定義書のページ、振る舞いの一覧、JUnit の取り込み | US3・US5・FR-009・FR-015・FR-016・FR-020 |
| 15 | spec 020 の契約に、定義書を正とする旨を足す。CLAUDE.md の表と `.githooks/README.md` を直す | FR-018 |

人の書く量が多い段階（3〜7、11〜13）は、PR を分けても CI を通せるように、確認を段階的に有効にする。プラグインごとに、項目の欠けを許すかと、テストの無い項目を許すかを、`libs/interface-spec/targets.json` に持つ。最後の段階で、3 プラグインとも許さない設定になる。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 新しい nx の project `libs/interface-spec` を足す | 3 プラグインが、同じ形式・同じ検証・同じ生成を使う | プラグインごとに写すと、形式と確認が食い違う。`.githooks/scripts/` には、vitest と eslint の設定を持つ場所が無い |
| 開発用の Python（sphinx-needs）を足す | 項目・テスト・合否を 1 つの HTML に結ぶ。#200 で、vitest と pytest の両方を取り込めるのはこれだけだと確かめた | 自前の HTML の生成は、JUnit の取り込みと項目のつなぎを作り直すことになる |
| 定義書を 2 つのファイルに分ける | 書き出しが、人の書いた欄に触れない | 1 つの YAML への書き戻しは、コメントと並びを保つ処理が要る |

## 残る確かめ

| 点 | いつ確かめるか |
|---|---|
| `vitest/valid-title` が、`describe` と `it` の題を別々の形で止められるか | 段階 9 の最初 |
| version plan の確認が、release の group に無い project の変更で plan を求めないか | 段階 1 |
| typer の引数の型（path・choice・複数指定）から JSON Schema への写しで、表せないものが無いか | 段階 2 |
| ソースの文字列から環境変数の名前を集める形（`os.environ`・`process.env` の読み方）で、取りこぼしが無いか | 段階 1 |
| EARS の型と日本語の文の形を比べる規則が、実物の項目で厳しすぎないか | 段階 3 |
| 表示の HTML を CI の artifact に上げるか | 段階 14。まずは手元で作れる形にする |
