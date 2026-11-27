## 0.2.12 (2026-11-27)

### 🩹 Fixes

- 開発用のテストの **Allure の結果** に、機能の階層（epic・feature・story）を付けた。プラグインとライブラリの動作は変わらない。 ([#848](https://github.com/pecotcraft/pecot/pull/848), [#811](https://github.com/pecotcraft/pecot/issues/811))
- 配布する依存の解決を、root の lock の今の版（typescript-eslint 8.72.2 など）にそろえた。 ([#845](https://github.com/pecotcraft/pecot/pull/845), [#792](https://github.com/pecotcraft/pecot/issues/792))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.11 (2026-11-27)

### 🩹 Fixes

- runtime-lock.yaml から、使われなくなった @typescript-eslint の古い版を外した。動作は変わらない。 ([#828](https://github.com/pecotcraft/pecot/pull/828), [#809](https://github.com/pecotcraft/pecot/issues/809))
- テストに **名前の付いた Allure の step** を書き、step の無いテストがあるとテストのレーンが止まるようにした。ライブラリの動作は変わらない。 ([#833](https://github.com/pecotcraft/pecot/pull/833), [#814](https://github.com/pecotcraft/pecot/issues/814))
- 開発用のテストが、テストレポートに **何を確認したかの説明** を残す。プラグインの動作は変わらない。 ([#842](https://github.com/pecotcraft/pecot/pull/842), [#815](https://github.com/pecotcraft/pecot/issues/815))
- 開発用のテストが、判定で使った **CLI・MCP・hook の出力** を Allure の添付として残す。プラグインの動作は変わらない。 ([#831](https://github.com/pecotcraft/pecot/pull/831), [#816](https://github.com/pecotcraft/pecot/issues/816))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.10 (2026-11-26)

### 🩹 Fixes

- 開発用の vitest の設定が、nx のレーンから動いたときに **Allure の結果** も残すようにした。プラグインの動作は変わらない。 ([#719](https://github.com/pecotcraft/pecot/pull/719), [#693](https://github.com/pecotcraft/pecot/issues/693))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.9 (2026-11-18)

### 🩹 Fixes

- `.textlintignore`（textlint の標準の除外ファイル）で外したファイルを、`pecot-text-lint` が飛ばすようになった。 ([#566](https://github.com/pecotcraft/pecot/pull/566), [#555](https://github.com/pecotcraft/pecot/issues/555))
  pecot-visual の書くたびの text lint も、リポのルートの `.textlintignore` に従う。

- 表を回すテストの題の **`$キー` が読めない形**だと lint が止め、**同じファイルで題が重なる**とテストが止める。 ([#626](https://github.com/pecotcraft/pecot/pull/626), [#606](https://github.com/pecotcraft/pecot/issues/606))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.8 (2026-11-16)

### 🩹 Fixes

- `eslint` を 10.14.0 から 10.15.0 に更新。 ([#448](https://github.com/pecotcraft/pecot/pull/448), [#446](https://github.com/pecotcraft/pecot/issues/446))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.7 (2026-11-13)

### 🩹 Fixes

- 公開面のテストのいちばん外の `describe` の題が定義書の `name` に無いと、lint が止める。 ([#331](https://github.com/pecotcraft/pecot/pull/331), [#279](https://github.com/pecotcraft/pecot/issues/279))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.6 (2026-11-11)

### 🩹 Fixes

- lock の作り直しで推移依存が変わった。 ([#270](https://github.com/pecotcraft/pecot/pull/270), [#247](https://github.com/pecotcraft/pecot/issues/247))
  `@babel/parser` を 7.29.9 から 7.29.13 に更新し、重複した `@typescript-eslint/*` と `parse5` を 1 つの版にまとめた。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

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
