# Quickstart: インタフェース定義書の確かめ方

実装の後に、spec の User Story ごとに動かして確かめる手順を並べる。欄の形は [contracts/definition-format.md](contracts/definition-format.md)、テストの書き方は [contracts/test-conventions.md](contracts/test-conventions.md) にある。

## 前提

- devcontainer の中で動かす。Node・uv・pnpm は入っている
- `pnpm install` を済ませておく

## US1: pecot-workflow の定義書と一致の確認

```bash
# 書き出し直したものと、リポジトリの generated.json を比べる
plugins/pecot-workflow/scripts/interface/export.py --check
```

| 操作 | 期待 |
|---|---|
| そのまま動かす | 終了コード 0 |
| `cli/commands/issue.py` の `issue create` にオプションを 1 つ足して動かす | 終了コード 1。`PW-ISSUE-CREATE: input.properties.<名前>: added` と、直すコマンドが出る |
| `--write` で書き出し直し、`pnpm exec nx run interface-spec:lint-defs` を動かす | 通る。`authored.yaml` は変わっていない |
| `main.py` にコマンドを 1 つ足して `--write` し、`lint-defs` を動かす | 終了コード 1。足したコマンドの ID と `entry is missing` が出る。`targets.json` で `entries: complete` にした後（#254）に確かめる |
| `authored.yaml` の `constraints` の引数の名前を 1 字変える | `lint-defs` が `unknown input name` で止まる |
| `authored.yaml` の 1 項目から `on_error` を消す | `lint-defs` が `field is missing` で止まる。`default` と書くと通る |
| `pattern: event` の項目の文を「もし〜なら、〜する」に変える | `lint-defs` が `statement does not match pattern` で止まる |
| CLI のソースに、新しい環境変数を読む行を足す | `lint-defs` が、変数の名前と読んでいるファイルを出して止まる |

## US2: pecot-tools と pecot-visual の定義書

```bash
pnpm --dir plugins/pecot-tools/cli exec tsx scripts/export-interface.ts --check
pnpm --dir plugins/pecot-visual/cli exec tsx scripts/export-interface.ts --check
```

| 操作 | 期待 |
|---|---|
| そのまま動かす | 終了コード 0 |
| ツールの zod の入力に項目を 1 つ足して動かす | 終了コード 1。ツールの ID と、足した項目が出る |
| 読み取りだけのツールの `effects` に `kind: write` を書いて `lint-defs` を動かす | 止まる。annotations との食い違いが出る |
| pecot-tools の許可リストにコマンドを 1 つ足して動かす | 終了コード 1。新しいツールの ID が `added` で出る |

## US3: `commands.md` と表示

```bash
pnpm exec nx run interface-spec:lint-defs      # commands.md の鮮度も見る
pnpm exec nx run interface-spec:docs           # 表示の HTML を作る
python3 -m http.server -d libs/interface-spec/docs/_build
```

| 操作 | 期待 |
|---|---|
| `generated.json` の説明を 1 つ変えて `lint-defs` を動かす | 終了コード 1。`commands.md is stale` と、作り直すコマンドが出る |
| 作り直すコマンドを動かす | `commands.md` の該当の行が変わり、`lint-defs` が通る |
| HTML を開く | プラグインごとのページに、全項目の説明・引数の表・副作用・終了コードが出る |

## US4: テストの規約とつなぎ

| 操作 | 期待 |
|---|---|
| 規約の対象の vitest に `it('works', …)` を足して lint を動かす | 止まる。題に日本語が無いと出る |
| テストに `verifies(ctx, 'PT-AWS-S3-LS-99')` を足して `lint-defs` を動かす | 止まる。ファイルと行と `is not defined` が出る |
| pytest に `@add_test_properties(verifies=["PW-NOPE-01"])` を足して `lint-defs` を動かす | 同じく止まる |

## US5: 振る舞いの一覧

```bash
# JUnit を出しながらテストを動かし、表示を作る
pnpm exec nx run-many -t test
pnpm exec nx run interface-spec:docs
```

| 操作 | 期待 |
|---|---|
| `authored.yaml` に、テストの無い振る舞いの項目を 1 つ足して `lint-defs` を動かす | 終了コード 1。`<ID> has no test` が出る |
| HTML で任意のコマンドの項目を開く | 振る舞いの項目ごとに、つないだテストの名前と合否が並ぶ |
| pecot-workflow のページと pecot-tools のページを開く | pytest の結果と vitest の結果が、同じ形で出る |
| JUnit の無い状態で `docs` を動かす | HTML は作られ、合否は「未実行」と出る |
