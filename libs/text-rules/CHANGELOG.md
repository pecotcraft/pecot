## 0.2.5 (2026-11-10)

### 🩹 Fixes

- vite の catalog の範囲の確認を、@slidev/cli の宣言との一致ではなく、その範囲に入るかで見るようにした。入る vite の版と配布物の挙動は変わらない。 ([#240](https://github.com/pecotcraft/pecot/pull/240), [#236](https://github.com/pecotcraft/pecot/issues/236))
- nx が undici の修正版を宣言したので、`runtime-workspace.yaml` から **undici の override** を外した。 ([#169](https://github.com/pecotcraft/pecot/pull/169), [#168](https://github.com/pecotcraft/pecot/issues/168))
  lock の作り直しで、推移依存の patch 更新も入った。

- vite の版を、pnpm の catalog の 1 か所で決めるようにした。実行用の依存の lock は catalog の項目を持つ。入る vite の版は変わらない。 ([#196](https://github.com/pecotcraft/pecot/pull/196), [#170](https://github.com/pecotcraft/pecot/issues/170))
  単体配布の `setup` は、配布物の実行時依存の manifest に `catalog:` が残っていると、npm を起動せずに配布物の破損として止まる。

- jsdom を 31 に上げた（テスト用の devDependency）。 ([#203](https://github.com/pecotcraft/pecot/pull/203), [#198](https://github.com/pecotcraft/pecot/issues/198))
  lock の作り直しで、推移依存も変わった。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.4 (2026-11-09)

### 🩹 Fixes

- テストの target の説明文を、CI がテストを動かす前提に直した。動きは変わらない。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- テストの上限を 30 秒に延ばす。配布物の動作は変わらない。 ([#132](https://github.com/pecotcraft/pecot/pull/132), [#131](https://github.com/pecotcraft/pecot/issues/131))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))
- `scripts/ready.mjs` は、root フックが dist を使えるかを判定する。CodeQL が構文エラーとして解析から外していたので、読める書き方へ改めた。判定の結果は変わらない。 ([#73](https://github.com/pecotcraft/pecot/pull/73), [#58](https://github.com/pecotcraft/pecot/issues/58))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.3 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
