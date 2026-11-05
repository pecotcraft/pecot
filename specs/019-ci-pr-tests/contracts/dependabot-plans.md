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
| `--dry-run` | 書かずに、作る plan のパスと中身を標準出力に出す |

## 入力

- `git log` で読んだ commit のうち、author 名が `dependabot[bot]` のもの
- 範囲は `<tag>...HEAD` で、`--cherry-pick --right-only` を付ける
- これで、tag の側と中身の同じ commit を除く。force push の後の重複を防ぐためである（FR-030）
- `nx.json` の `release.groups`（group 名と project の対応）
- 配布物の一覧（pecot-visual の `dist-manifest.mjs` の依存名）

読み方と判定は data-model の 4・5 節に従う。

## 出力

data-model の 6 節に従う。標準出力の最後に、作った件数・作らなかった件数とその理由（開発用・root・既にある）を 1 行ずつ出す。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（作った plan が 0 件でも 0） |
| 1 | commit の本文が読めない、作った plan が形式の確認か文言規則に通らない |
| 2 | 引数の誤り |

## テストの観点

- 単独の PR（#5 の実物の本文）から、`5-dependabot-deps.md` と期待どおりの本文ができる
- group の PR で、production と development が両方あるとき、production だけが本文に載る
- development だけの PR、root の PR、github-actions の PR では plan を作らない
- 2 つの group に届く PR では、group ごとに別のファイルができる
- 依存が多くて 100 字を超えるとき、「ほか N 件」で締めて 100 字以内に収まる
- 同じ名前の plan が既にあるときは上書きしない
- `updated-dependencies:` が欠けた本文ではコード 1 で止まる
- 履歴を書き換えて tag が HEAD の祖先でなくなっても、配布済みの更新の plan を作らない

テストの入力の本文は、実物の dependabot の commit から写した値を使う。依存名は実在の名前のままでよい。
