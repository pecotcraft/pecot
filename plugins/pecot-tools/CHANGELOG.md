## 1.1.1 (2026-11-13)

### 🩹 Fixes

- 公開面のテストのいちばん外の `describe` の題が定義書の `name` に無いと、lint が止める。 ([#331](https://github.com/pecotcraft/pecot/pull/331), [#279](https://github.com/pecotcraft/pecot/issues/279))
- MCP 単体配布の組み立て手順を 3 プラグインで共通にし、pecot-visual の依存解決にも取得のタイムアウトと再試行の上限を設ける。 ([#393](https://github.com/pecotcraft/pecot/pull/393), [#352](https://github.com/pecotcraft/pecot/issues/352))
- MCP の単体配布の登録例が、pnpm の `devEngines` を持つリポを cwd にしても起動する。 ([#398](https://github.com/pecotcraft/pecot/pull/398), [#391](https://github.com/pecotcraft/pecot/issues/391))
  登録例はパッケージを位置引数で渡し、`npm_config_package` をサーバの子の npx に残さない。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.1.0 (2026-11-11)

### 🚀 Features

- pecot-tools の診断行の前置きを `error:` にそろえ、MCP ツールの文言と進捗通知を英語にした。 ([#276](https://github.com/pecotcraft/pecot/pull/276), [#215](https://github.com/pecotcraft/pecot/issues/215))
  3 プラグインの launcher（`bin/`・`setup.sh`）が出す文言も英語にした。


### 🩹 Fixes

- lock の作り直しで推移依存が変わった。 ([#270](https://github.com/pecotcraft/pecot/pull/270), [#247](https://github.com/pecotcraft/pecot/issues/247))
  `@babel/parser` を 7.29.9 から 7.29.13 に更新し、重複した `@typescript-eslint/*` と `parse5` を 1 つの版にまとめた。

- 26 の MCP ツールのインタフェース定義書を `interface/` に置いた。ツールの入力・出力・注釈を変えて書き出し直さないと、CI が止める。 ([#285](https://github.com/pecotcraft/pecot/pull/285), [#249](https://github.com/pecotcraft/pecot/issues/249))
- テストが、確かめる振る舞いの項目の ID を JUnit に書き出す。定義書に無い ID を書いたテストは、CI が止める。 ([#314](https://github.com/pecotcraft/pecot/pull/314), [#256](https://github.com/pecotcraft/pecot/issues/256))
- 古い Node.js で起動した CLI の案内の 2 行目以降が、ほかの診断行と同じ空白 2 つで始まるようにした。 ([#278](https://github.com/pecotcraft/pecot/pull/278), [#275](https://github.com/pecotcraft/pecot/issues/275))
- pecot-visual の MCP ツールの説明文・結果・エラー、slide_lint の規則の文言、CLI の行を英語にする。 ([#269](https://github.com/pecotcraft/pecot/pull/269), [#214](https://github.com/pecotcraft/pecot/issues/214))
  `slide sync` が書く talk-dir の設定のコメントも英語になり、PPTX の変換が 1 回やり直しになる。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.0.2 (2026-11-10)

### 🩹 Fixes

- vite の catalog の範囲の確認を、@slidev/cli の宣言との一致ではなく、その範囲に入るかで見るようにした。入る vite の版と配布物の挙動は変わらない。 ([#240](https://github.com/pecotcraft/pecot/pull/240), [#236](https://github.com/pecotcraft/pecot/issues/236))
- nx が undici の修正版を宣言したので、`runtime-workspace.yaml` から **undici の override** を外した。 ([#169](https://github.com/pecotcraft/pecot/pull/169), [#168](https://github.com/pecotcraft/pecot/issues/168))
  lock の作り直しで、推移依存の patch 更新も入った。

- vite の版を、pnpm の catalog の 1 か所で決めるようにした。実行用の依存の lock は catalog の項目を持つ。入る vite の版は変わらない。 ([#196](https://github.com/pecotcraft/pecot/pull/196), [#170](https://github.com/pecotcraft/pecot/issues/170))
  単体配布の `setup` は、配布物の実行時依存の manifest に `catalog:` が残っていると、npm を起動せずに配布物の破損として止まる。

- `commander` を 15.0.0 から 15.1.0 に更新。(#172) ([#224](https://github.com/pecotcraft/pecot/pull/224), [#220](https://github.com/pecotcraft/pecot/issues/220))
- jsdom を 31 に上げた（テスト用の devDependency）。 ([#203](https://github.com/pecotcraft/pecot/pull/203), [#198](https://github.com/pecotcraft/pecot/issues/198))
  lock の作り直しで、推移依存も変わった。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.0.1 (2026-11-09)

### 🩹 Fixes

- リリースのブランドの語の確認を外した。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- hook のスクリプトの置き場を変えた参照を直した。 ([#107](https://github.com/pecotcraft/pecot/pull/107), [#64](https://github.com/pecotcraft/pecot/issues/64))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 1.0.0 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
