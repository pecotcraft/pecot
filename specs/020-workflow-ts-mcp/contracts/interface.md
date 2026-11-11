# Contract: 定義書との比較と、振る舞いの項目のつなぎ

定義書の形式・lint・ID の規約の正は `libs/interface-spec/` と spec 022 です。この文書は、移行の間だけ要る決めを書きます。

## 書き出しのスクリプト

置き場は `plugins/pecot-workflow/cli-node/scripts/export-interface.ts`。元は `src/commands/registry.ts` の `COMMANDS`。

| 引数 | 動き | 終了コード |
|---|---|---|
| `--check` | `COMMANDS` から作った項目を、`interface/generated.json` の同じ ID の項目と比べる。ファイルは書かない | 差が無ければ 0、あれば 1 |
| `--write` | `generated.json` を Node の項目で書く。切り替えの PR（フェーズ 11）で実装する。それまでは使い方のエラーにする | 0。切り替えの前は 2 |
| それ以外 | 使い方を標準エラーに出す | 2 |

## `--check` の比べ方

| 条件 | 切り替えの前 | 切り替えの後 |
|---|---|---|
| 比べる項目 | `COMMANDS` に登録したコマンドの ID だけ | 全部の項目 |
| 比べる欄 | `input` と `cli` | 項目の全部の欄 |
| Node にあって定義書に無い ID | 失敗 | 失敗 |
| 定義書にあって Node に無い ID | 見ない | 失敗 |
| 登録が 0 件 | warning を 1 行出して 0 | 起こらない |

差の表示は `libs/interface-spec` の `formatStale` の形にします。差のある項目の ID と欄が分かる行を、標準エラーに出します。

## 流す場所

| 確認 | レーン | 置き場 |
|---|---|---|
| `--check` | `pecot-workflow:test-cli` | `cli-node/tests/interface-export.test.ts` |
| 移したコマンドの項目のつなぎ | `pecot-workflow:test-cli` | 同じファイル |
| 全部の項目のつなぎと、定義書に無い ID | `interface-spec:lint-defs` | 済み |

## 移したコマンドの項目のつなぎ

登録済みのコマンドごとに、`authored.yaml` から、その項目の振る舞いの ID を集めます。登録済みとは、`COMMANDS` にあることです。
集めた ID の文字列が、次のファイルのどれかにあることを確かめます。無い ID があれば、ID を並べて失敗します。

| 対象 | パス |
|---|---|
| 見る | `cli-node/tests/**/*.ts`、`cli-node/src/**/tests/**/*.ts` |
| 見ない | `cli-node/tests/parity/**` |

共通の項目 `PW-COMMON-NN` は、登録の数に依らず確かめます。フェーズ 1 でつなぎます。

## vitest のケースの書き方

- 題は `.claude/rules/test-conventions.md` の規約に従う
- ケースの最初で `await verifies(context, 'PW-…')` を呼ぶ。1 つのケースが複数の項目を確かめるなら、ID ごとに呼ぶ
- 期待値は、項目の文と、今つながっている pytest のケースの期待値から取る
- モックは I/O 境界（偽の GitHub サーバ、一時 git リポ、子プロセス）だけにする

## 定義書の仕組みの読む先

| ファイル | 切り替えの前 | フェーズ 11 | フェーズ 12 |
|---|---|---|---|
| `libs/interface-spec/targets.json` の `sources` | `cli/**/*.py`・`bin/*`・`hooks/**/*.sh` | `cli-node/src/**/*.ts`・`bin/*`・`hooks/**/*.sh` | `cli/src/**/*.ts` に直す |
| 同じファイルの `tests` | pytest と cli-node のテスト | 変えない | Python を外し、`cli/tests/**/*.ts`・`cli/src/**/tests/**/*.ts` にする |
| `libs/interface-spec/project.json` の `lint-defs` の inputs | 上の 2 つと同じ | `sources` に合わせる | `tests` に合わせる |
| `libs/interface-spec/docs/conf.py` の `iface_junit` | Python と cli-node の JUnit | 変えない | `cli/test-results/junit.xml` を Node の JUnit のパスに直し、Python の分を外す |
