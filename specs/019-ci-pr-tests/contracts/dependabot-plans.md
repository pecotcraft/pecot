# Contract: 依存の更新の version plan を作るスクリプト

置き場は `.nx/nx-release/src/dependabot-plans.js`、テストは `.nx/nx-release/tests/dependabot-plans.test.js` とする。
`nx-release:test-unit`（`node --test`）で動く。

## 呼び方

```text
node .nx/nx-release/src/dependabot-plans.js [--dry-run] [--since-ref <ref>]
```

| 引数 | 意味 |
|---|---|
| なし | release group ごとに最新の tag（`<group>-v*`）から `HEAD` までを読み、plan を `.nx/version-plans/` に書く |
| `--since-ref <ref>` | 全 group で同じ起点を使う（テスト用） |
| `--dry-run` | `.nx/version-plans/` に書かず、`.pecot/tmp/dependabot-plans/` に書いて確認し、パスと中身を標準出力に出す |

## 入力

- `git log` で読んだ commit のうち、本文に `updated-dependencies:` を含むもの。作者では選ばない
- 範囲は group ごとに、最新の `<group>-v*` の tag（`--sort=-v:refname`）から `HEAD` までとする。`git log --cherry-pick --right-only <tag>...HEAD` で読む
- tag の無い group は全履歴を読む
- これで、tag の側と中身の同じ commit を除く。force push の後の重複を防ぐためである（FR-030）。diff が変わった commit は除けず、plan が重なる
- `nx.json` の `release.groups`（group 名と project の対応）
- 配布物の依存名（pecot-visual の `buildDistManifest()` の戻り値のキー）。純関数には引数で渡し、テストでは fixture を渡す
- 変わった `package.json`・宣言・root の lock（commit の時点のもの）

directory が読めない件名は `/` として読む。group は directory ではなく、`package.json` と lock で決める。
読み方と判定は data-model の 4・5 節に従う。

## 出力

data-model の 6 節に従う。標準出力の最後に、作った件数と、作らなかった件数を理由ごとに 1 行ずつ出す。理由の語は「開発用」「どの package にも当たらない」「既にある」とする。
ファイル名の `-<group>` は、範囲で絞る前の group の数で決める。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（作った plan が 0 件でも 0） |
| 1 | commit の本文が読めない、件名の末尾に `(#N)` が無い、作った plan が形式の確認か文言規則に通らない |
| 2 | 引数の誤り |

## テストの観点

- 単独の PR（#5 の実物の本文）から、`5-dependabot-deps.md` と期待どおりの本文ができる
- group の PR で、production と development が両方あるとき、production だけが本文に載る
- development だけの PR、どの package にも当たらない PR、github-actions の PR では plan を作らない
- 2 つの group に届く PR では、group ごとに別のファイルができる
- 依存が多くて 100 字を超えるとき、「ほか N 件」で締めて 100 字以内に収まる
- 同じ名前の plan が既にあるときは上書きしない
- `updated-dependencies:` が欠けた本文ではコード 1 で止まる
- 履歴を書き換えて tag が HEAD の祖先でなくなっても、配布済みの更新の plan を作らない
- #113 の後の 2 commit の squash の本文。入力は open の #120（単独）と #151（group）の実物から組み立てる
- directory の無い件名を `/` として読む
- 版の割れた `@types/node` で、指定の変わった package だけに作る
- `indirect` が dev の依存からしか届かないときは作らない

テストの入力の本文は、実物の dependabot の commit から写した値を使う。依存名は実在の名前のままでよい。
