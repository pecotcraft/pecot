# Quickstart: 出力がそろったことを確かめる

各 PR の後に、変えた範囲について次を確かめる。行の形は [contracts/output-lines.md](contracts/output-lines.md) にある。

## 前提

- devcontainer の中で、`pnpm install` と `plugins/pecot-workflow/cli` の `uv sync` が済んでいる
- 実ボードには書き込まない。偽の GitHub（parity のシナリオ）と pytest の fake だけを使う

## 1. 共通の関数が契約どおりの行を出す（US4）

```bash
cd plugins/pecot-workflow/cli && uv run pytest tests/cli/test_output.py
pnpm -C plugins/pecot-workflow/cli-node exec vitest run tests/output
```

期待: どちらも `cases.json` の全件が一致する。

## 2. Tracker の sync の行（US1）

```bash
cd plugins/pecot-workflow/cli && uv run pytest tests -k "dependabot_sync or security_sync"
```

期待:

- dry-run なしの実行で、Tracker ごとに `updated: Tracker #<n> body` のような result の行が 1 行だけ出る
- `dry-run:` で始まる行は出ない
- dry-run ありの実行で、同じ事柄が `dry-run: would update Tracker #<n> body` と出る
- どの行にも `null`・`None` が出ない

## 3. golden と Python の CLI が一致する（US2）

```bash
pnpm -C plugins/pecot-workflow/cli-node run record:parity:check
```

期待: 差が 0 件。golden の全行で `✔`・`✓` が 0 個、日本語の固定の文言が 0 個。

## 4. 直接の出力を lint が止める（US3）

```bash
cd plugins/pecot-workflow/cli && echo 'import typer; typer.echo("x")' >> commands/issue.py && uv run ruff check commands/issue.py; git checkout commands/issue.py
```

期待: `TID251` で失敗する。`_output.py` を使うよう示す。Node の 3 つは `process.stderr.write("x\n")` を足し、`eslint` が失敗することを同じように確かめる。

## 5. pecot-visual・pecot-tools の診断行（US5）

```bash
pnpm -C plugins/pecot-visual/cli exec vitest run tests -t "warning"
pnpm -C plugins/pecot-tools/cli exec vitest run tests -t "runtime"
```

期待: 結果の stderr の行が `warning:` か `error:` で始まる。`[warn]`・`pecotv:`・`pecot-tools:` は出ない。stdout に JSON-RPC 以外の行が出ない。

MCP ツールの文言（FR-015）は、各プラグインの英語のテストで確かめる。

```bash
pnpm -C plugins/pecot-visual/cli exec vitest run tests/english-only.test.ts
pnpm -C plugins/pecot-tools/cli exec vitest run tests/english-only.test.ts
```

期待: `src/` の文字列リテラル（結果の `message`・エラーの文言・ツールの説明文）に、日本語の文字が 0 個。

## 6. 日本語の固定の文言が残っていない（SC-007）

```bash
cd plugins/pecot-workflow/cli && uv run pytest tests/unit/test_english_only.py
cd plugins/pecot-workflow/hooks && uv run --project ../cli pytest tests/test_english_only.py
plugins/pecot-visual/hooks/tests/english-only.test.sh
```

期待: `cli/commands/` の文字列リテラルと docstring、hooks の shell のコメントでない行に、日本語の文字が 0 個。
