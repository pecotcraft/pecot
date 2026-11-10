# Contract: 依存の更新の version plan を作るスクリプト

置き場は `.nx/nx-release/src/dependabot-plans.js`、テストは `.nx/nx-release/tests/dependabot-plans.test.js` とする。
`nx-release:test-unit`（`node --test`）で動く。
動かすのは `dependabot-commit.yml` と、必須チェック `version-plan` である（#220）。

## 呼び方

```text
node .nx/nx-release/src/dependabot-plans.js --pr <N> --base <ref> [--dry-run]
node .nx/nx-release/src/dependabot-plans.js --check --base <ref>
```

| 引数 | 意味 |
|---|---|
| `--pr <N>` | PR 番号。plan のファイル名 `<N>-dependabot-deps.md` に使う |
| `--base <ref>` | 範囲の base（例 `origin/main`）。base との merge-base から `HEAD` までを読む |
| `--dry-run` | `.nx/version-plans/` に書かず、`.pecot/tmp/dependabot-plans/` に書いて確認し、パスと中身を標準出力に出す |
| `--check` | plan を書かない。`--pr` の代わりに範囲内の dependabot の更新を調べ、plan が欠けていればコード 1 で止める |

## 入力

- 範囲は `<base>` と `HEAD` の merge-base から `HEAD` までの commit とする。tag は起点にしない
- `git log` で読んだ commit のうち、本文に `updated-dependencies:` だけの行を持つもの。作者では選ばない
- `nx.json` の `release.groups`（group 名と project の対応）
- 配布物の依存名（pecot-visual の `buildDistManifest()` の戻り値のキー）。純関数には引数で渡し、テストでは fixture を渡す
- 変わった `package.json`・宣言・root の lock（commit の時点のもの）

directory が読めない件名は `/` として読む。group は directory ではなく、`package.json` と lock で決める。
`plugins/pecot-visual/scripts/release/audit-canary/` の宣言は数えない。
uv は、その commit で `<directory>/uv.lock` が変わったかで判定する。`indirect` は、その commit の `uv.lock` でプロジェクトの本番の依存から辿って届くときだけ作る。dev からしか届かなければ「開発用」とする。
読み方と判定は data-model の 4・5 節に従う。

## 出力

data-model の 6 節に従う。plan の本文の末尾に `(#N)` は付けない。squash commit の件名の `(#N)` から、nx が PR へのリンクを付ける。
標準出力の最後に、作った件数と、作らなかった件数を理由ごとに 1 行ずつ出す。行は次の 4 つとする。「PR」の行は commit 単位、「plan ファイル」の行はファイル単位で数える。

```text
作った plan ファイル: N 件
作らなかった dependabot の PR（開発用）: N 件
作らなかった dependabot の PR（どの package にも当たらない）: N 件
作らなかった plan ファイル（既にある）: N 件
```

plan は commit の古い順に出す。理由の語は「開発用」「どの package にも当たらない」「既にある」とする。
ファイル名の `-<group>` は、その commit が届く group が 2 つ以上のときに付ける。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（作った plan が 0 件でも 0）。`--check` では plan の欠けが無い |
| 1 | commit の本文が読めない、作った plan が形式の確認か文言規則に通らない、`indirect` があるのに uv.lock を読めない、`--check` で plan が欠けている。例外で止まるときも、書いた plan は消す |
| 2 | 引数の誤り（`--pr` か `--base` が無い、`--check` と `--pr` の併用など） |

## テストの観点

- 単独の PR（#5 の実物の本文）から、`5-dependabot-deps.md` と期待どおりの本文ができる。本文の末尾に `(#N)` は無い
- group の PR で、production と development が両方あるとき、production だけが本文に載る
- development だけの PR、どの package にも当たらない PR、github-actions の PR では plan を作らない
- 2 つの group に届く PR では、group ごとに別のファイルができる
- 依存が多くて 100 字を超えるとき、「ほか N 件」で締めて 100 字以内に収まる
- 同じ名前の plan が既にあるときは上書きしない
- `updated-dependencies:` が欠けた本文ではコード 1 で止まる
- `--pr` か `--base` が無いときはコード 2 で止まる
- `--check` は、plan が揃っていれば 0、欠けていれば 1 で止まる
- directory の無い件名を `/` として読む
- 版の割れた `@types/node` で、指定の変わった package だけに作る
- `indirect` が dev の依存からしか届かないときは作らない

テストの入力の本文は、実物の dependabot の commit から写した値を使う。依存名は実在の名前のままでよい。
