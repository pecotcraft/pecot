# Contract: 定義書との比較と、振る舞いの項目のつなぎ

定義書の形式・lint・ID の規約の正は `libs/interface-spec/` と spec 022 です。この文書は、移行の間だけ要る決めを書きます。

## 書き出しのスクリプト

置き場は `plugins/pecot-workflow/cli-node/scripts/export-interface.ts`。元は `src/commands/registry.ts` の `COMMANDS`。

| 引数 | 動き | 終了コード |
|---|---|---|
| `--check` | `COMMANDS` から作った項目を、`interface/generated.json` の同じ ID の項目と比べる。ファイルは書かない | 差が無ければ 0、あれば 1 |
| `--write` | `generated.json` を Node の項目で書く。切り替えの PR（フェーズ 11）で実装する。それまでは、登録が 1 件以上なら使い方のエラーにする | 0。切り替えの前で登録が 1 件以上なら 2 |
| それ以外 | 使い方を標準エラーに出す | 2 |

登録が 0 件のときは、`--check` と `--write` のどちらでも、warning を 1 行出して 0 で終わります。今の実装のままです。

## `--check` の比べ方

| 条件 | 切り替えの前 | 切り替えの後 |
|---|---|---|
| 比べる項目 | `COMMANDS` に登録したコマンドの ID だけ | 全部の項目 |
| 比べる欄 | `surfaces.mcp` 以外の全部（`input`・`cli`・`name`・`description`・`hidden`・`deprecated`・`surfaces.cli`） | 項目の全部の欄 |
| Node にあって定義書に無い ID | 失敗 | 失敗 |
| 定義書にあって Node に無い ID | 見ない | 失敗 |
| 登録が 0 件 | warning を 1 行出して 0 | 起こらない |

`surfaces.mcp` を除くのは、Python 側の書き出しに無い欄だからです。Python と Node の書き出しの差は、この欄だけです。

### 絞り方

`diffGenerated` は、項目と欄を絞る引数を持ちません。呼ぶ側で絞ります。

- 定義書の側は、項目を Node の ID だけにしたものを渡す
- Node の側は、項目から `surfaces.mcp` を除いたものを渡す
- 切り替えの後は、どちらも絞らずに渡す

`GeneratedFile` の型は配列が変更可能です。渡す前に写します。
`libs/interface-spec` の読み方は、pecot-tools の `cli/scripts/export-interface.ts` と同じく相対パスです。

### 差の表示

`diffGenerated` が返す行（`<ID>: <欄>: <前> -> <後>`）を、`createOutput().error` に渡します。差のある項目の ID と欄が分かります。

- 切り替えの前は `formatStale` を使わない。`error: ... is stale` と `--write` を促す行を出すため
- 切り替えの後は `formatStale` を使う

### テストの前提

- `main` は `generated.json` のパスを差し替える引数を持つ（pecot-tools の `options.target` と同じ）。テストは、一時ファイルに置いた定義書で確かめる
- テストに書く見本の ID は、`lint-defs` が拾う形（`PW-…-NN`）の文字列をそのまま書かない。文字列の連結で作る
- 登録が 1 件以上で切り替えの前に `--write` を打つと、使い方のエラー（終了コード 2）にする

## 流す場所

| 確認 | レーン | 置き場 |
|---|---|---|
| `--check` | `pecot-workflow:test-cli` | `cli-node/tests/interface-export.test.ts` |
| 移したコマンドの項目のつなぎ | `pecot-workflow:test-cli` | `cli-node/tests/interface-export.test.ts` |
| 項目のケース | `pecot-workflow:test-cli` | `cli-node/tests/interface/<グループ>.test.ts` |
| 全部の項目のつなぎと、定義書に無い ID | `interface-spec:lint-defs` | 済み |

`--check` のために、新しいレーンは足しません。既存の `test-cli` で流します。

## 移したコマンドの項目のつなぎ

登録済みのコマンドごとに、`authored.yaml` から、その項目の振る舞いの ID を集めます。登録済みとは、`COMMANDS` にあることです。
集めた ID が、次のファイルのどれかの `verifies(` の引数にあることを確かめます。無い ID があれば、ID を並べて失敗します。

| 対象 | パス |
|---|---|
| 見る | `cli-node/tests/**/*.ts`、`cli-node/src/**/tests/**/*.ts` |
| 見ない | `cli-node/tests/parity/**`、コメントの中の ID |

ID のあるファイルが、`cli-node/vitest.config.ts` のどれかの project の include に当たることも確かめます。流れないケースの ID を数えないためです。

共通の項目 `PW-COMMON-NN` は、登録の数に依らず確かめます。フェーズ 1 でつなぎます。

## vitest のケースの書き方

- 項目のケースは `cli-node/tests/interface/<グループ>.test.ts` に置く。グループ無しのコマンドは、コマンド名のファイルにする。共通の項目は `tests/interface/common.test.ts` に置く。共通の項目のファイルは、いちばん外の `describe` を置かず、`it` を直下に並べる（`describe-title` の規則が、コマンド名でない題を止めるため）
- 題は `.claude/rules/test-conventions.md` の規約に従う。いちばん外の `describe` の題はコマンド名にする
- ケースの最初で `await verifies(context, 'PW-…')` を呼ぶ。1 つのケースが複数の項目を確かめるなら、ID ごとに呼ぶ
- 期待値は、項目の文と、今つながっている pytest のケースの期待値から取る
- モックは I/O 境界（偽の GitHub サーバ、一時 git リポ、子プロセス）だけにする
- 表を回すケースは `it.for` を使い、行に ID をリテラルで持たせる。`it.each` では `annotate` が使えない
- つなぎの確認は、`verifies(` の2つ目の引数がリテラルのファイルでは、その引数の ID を数える。リテラルでない呼び出し（`verifies(context, row.id)`）を持つファイルでは、コメントを除いた行の ID のリテラルを全部数える
- `tests/interface/` では `it.skip` と `it.todo` を使わない
- コマンドは `cli-node/src/cli.ts` の `runCli(argv, context)` をプロセス内で呼んで起動する。カバレッジに数えるため

### pytest の差し替えの読み替え

| pytest の差し替え | vitest での置き換え |
|---|---|
| `GitHubClient` | 偽の GitHub サーバ（`tests/fake-github/`）の応答 |
| `load_active_config` などの設定の読み | 一時ディレクトリに置いた設定ファイル |
| `git_current_branch` などの git の関数 | 一時 git リポ |
| 呼び出しの確認（`assert_called_with`） | 偽サーバが受けた要求の比較、または終わった後のファイルの比較 |

### 対応表

コマンドを移すフェーズの PR は、「項目の ID・元の pytest のケース・vitest のケース」の対応表を `.pecot/work/<Issue番号>/` に残します。

## 定義書の仕組みの読む先

この表を正にします。

| ファイル | 今 | フェーズ 1 | フェーズ 11 | フェーズ 12 |
|---|---|---|---|---|
| `libs/interface-spec/targets.json` の `sources` | `cli/commands/**/*.py`・`cli/core/**/*.py`・`cli/__init__.py`・`cli/__main__.py`・`bin/*`・`hooks/**/*.sh` | cli-node の製品コードを足す（`cli-node/src/**/*.ts`。テストは glob を分けて外す） | Python の 4 つを外す | `cli-node/` を `cli/` に直す |
| 同じファイルの `tests` | pytest と cli-node のテスト | 変えない | 変えない | Python を外し、`cli/tests/**/*.ts`・`cli/src/**/tests/**/*.ts` にする |
| `libs/interface-spec/project.json` の `lint-defs` の inputs | 上の 2 つと同じ | `sources` に合わせる | `sources` に合わせる | `sources` と `tests` に合わせる |
| `libs/interface-spec/docs/conf.py` の `iface_junit` | `cli/test-results/junit.xml`（Python）・`cli-node/test-results/junit.xml`・`cli-node/test-results/junit-hooks.xml` | 変えない | 変えない | `cli/test-results/junit.xml`（Node）と `cli/test-results/junit-hooks.xml` の 2 本にする |

フェーズ 1 では、`lint-defs` の環境変数の確認が出す失敗（試算で 41 件）を 0 件にします。やることは 3 つです。

- `authored.yaml` の `environment` に、製品コードが読む名前を足す
- 名前が文字列でない読みに、`interface-env:` の注記を付ける
- テストのファイルを、`sources` の glob から外す
