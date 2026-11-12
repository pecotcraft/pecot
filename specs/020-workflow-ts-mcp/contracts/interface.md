# Contract: 定義書との比較と、振る舞いの項目のつなぎ

定義書の形式・lint・ID の規約の正は `libs/interface-spec/` と spec 022 です。この文書は、移行の間だけ要る決めを書きます。

## 書き出しのスクリプト

置き場は `plugins/pecot-workflow/cli-node/scripts/export-interface.ts`。元は `src/commands/registry.ts` の `COMMANDS`。

| 引数 | 動き | 終了コード |
|---|---|---|
| `--check` | `COMMANDS` から作った項目を、`interface/generated.json` の全部の項目と比べる。ファイルは書かない | 直列化した文字列が同じなら 0、違えば 1 |
| `--write` | `COMMANDS` から作った `{format: 1, plugin: 'pecot-workflow', prefix: 'PW', entries}` を `generatedFileSchema` に通し、挿入順のまま `JSON.stringify(file, undefined, 2) + '\n'` で `generated.json` に書く。`wrote: <パス>` を標準出力に出す | 書けたら 0、書けなければ 1 |
| それ以外 | 使い方を標準エラーに出す | 2 |

登録が 0 件でも、`--check` と `--write` は同じ動きです（`--write` は空の `entries` で書く）。

## `--check` の比べ方

項目と欄は絞りません。Node にあって定義書に無い ID も、定義書にあって Node に無い ID も失敗です。`surfaces.mcp` も比べます。

1. 定義書の文字列が、Node の項目を直列化した文字列と同じなら 0
2. 違えば、`diffGenerated` の行（`<ID>: <欄>: <前> -> <後>`）を `formatStale` で包んで標準エラーに出し、1。1 行目は `error: <パス> is stale`。
   最後は `run: pnpm --dir plugins/pecot-workflow/cli-node exec tsx scripts/export-interface.ts --write`
3. 読めない・JSON でない・形式に合わないときは、`error: cannot read <パス>: <理由>` と `run:` の行を出して 1

`libs/interface-spec` の読み方は、pecot-tools の `cli/scripts/export-interface.ts` と同じく相対パスです。

### テストの前提

- `main` は `generated.json` のパスを差し替える引数を持つ（pecot-tools の `options.target` と同じ）。テストは、一時ファイルに置いた定義書で確かめる
- テストに書く見本の ID は、`lint-defs` が拾う形（`PW-…-NN`）の文字列をそのまま書かない。文字列の連結で作る

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
