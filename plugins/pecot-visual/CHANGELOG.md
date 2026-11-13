## 1.3.1 (2026-11-13)

### 🩹 Fixes

- 公開面のテストのいちばん外の `describe` の題が定義書の `name` に無いと、lint が止める。 ([#331](https://github.com/pecotcraft/pecot/pull/331), [#279](https://github.com/pecotcraft/pecot/issues/279))
- v-evidence の注記が、Excel でも LibreOffice でも spec の座標の位置に重なる。 ([#327](https://github.com/pecotcraft/pecot/pull/327), [#324](https://github.com/pecotcraft/pecot/issues/324))
- MCP 単体配布の組み立て手順を 3 プラグインで共通にし、pecot-visual の依存解決にも取得のタイムアウトと再試行の上限を設ける。 ([#393](https://github.com/pecotcraft/pecot/pull/393), [#352](https://github.com/pecotcraft/pecot/issues/352))
- `vite` を 8.3.7 から 8.3.8 に更新。 ([#390](https://github.com/pecotcraft/pecot/pull/390))
- MCP の単体配布の登録例が、pnpm の `devEngines` を持つリポを cwd にしても起動する。 ([#398](https://github.com/pecotcraft/pecot/pull/398), [#391](https://github.com/pecotcraft/pecot/issues/391))
  登録例はパッケージを位置引数で渡し、`npm_config_package` をサーバの子の npx に残さない。

- 定義書の振る舞いの項目のすべてに、確かめるテストがつながる。テストの無い項目は CI が止める。 ([#321](https://github.com/pecotcraft/pecot/pull/321), [#259](https://github.com/pecotcraft/pecot/issues/259))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.3.0 (2026-11-11)

### 🚀 Features

- pecot-visual の MCP ツールの説明文・結果・エラー、slide_lint の規則の文言、CLI の行を英語にする。 ([#269](https://github.com/pecotcraft/pecot/pull/269), [#214](https://github.com/pecotcraft/pecot/issues/214))
  `slide sync` が書く talk-dir の設定のコメントも英語になり、PPTX の変換が 1 回やり直しになる。


### 🩹 Fixes

- pecot-tools の診断行の前置きを `error:` にそろえ、MCP ツールの文言と進捗通知を英語にした。 ([#276](https://github.com/pecotcraft/pecot/pull/276), [#215](https://github.com/pecotcraft/pecot/issues/215))
  3 プラグインの launcher（`bin/`・`setup.sh`）が出す文言も英語にした。

- lock の作り直しで推移依存が変わった。 ([#270](https://github.com/pecotcraft/pecot/pull/270), [#247](https://github.com/pecotcraft/pecot/issues/247))
  `@babel/parser` を 7.29.9 から 7.29.13 に更新し、重複した `@typescript-eslint/*` と `parse5` を 1 つの版にまとめた。

- 11 の MCP ツールのインタフェース定義書を `interface/` に置いた。ツールの入力・出力・注釈を変えて書き出し直さないと、CI が止める。 ([#295](https://github.com/pecotcraft/pecot/pull/295), [#252](https://github.com/pecotcraft/pecot/issues/252))
- テストが、確かめる振る舞いの項目の ID を JUnit に書き出す。定義書に無い ID を書いたテストは、CI が止める。 ([#314](https://github.com/pecotcraft/pecot/pull/314), [#256](https://github.com/pecotcraft/pecot/issues/256))
- `playwright` を 1.64.1 から 1.65.0 に更新。 ([#263](https://github.com/pecotcraft/pecot/pull/263))
- 古い Node.js で起動した CLI の案内の 2 行目以降が、ほかの診断行と同じ空白 2 つで始まるようにした。 ([#278](https://github.com/pecotcraft/pecot/pull/278), [#275](https://github.com/pecotcraft/pecot/issues/275))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.2.0 (2026-11-10)

### 🚀 Features

- stderr の診断行の前置きを `error:`・`warning:`・`note:` にそろえた。 ([#226](https://github.com/pecotcraft/pecot/pull/226), [#208](https://github.com/pecotcraft/pecot/issues/208))
  `slide convert` の進捗と build の出力は stderr に移し、進捗は `--log-level verbose` のときだけ出す。


### 🩹 Fixes

- ページを編集したときに hooks が返す文脈を、UTF-8 のバイト数の上限で切るようにした。 ([#244](https://github.com/pecotcraft/pecot/pull/244), [#225](https://github.com/pecotcraft/pecot/issues/225))
  切ったときは、残りの違反の件数を通知の末尾に書く。違反が多いページでも、文脈がファイルに逃がされず、GitHub Copilot CLI でも捨てられない。

- `vite` を 8.3.6 から 8.3.7 に更新。 ([#229](https://github.com/pecotcraft/pecot/pull/229))
- draw.io の XML から **コメントを除去する処理** が、除去の跡で新しくできるコメントも取り除くようになった。 ([#237](https://github.com/pecotcraft/pecot/pull/237), [#234](https://github.com/pecotcraft/pecot/issues/234))
- vite の catalog の範囲の確認を、@slidev/cli の宣言との一致ではなく、その範囲に入るかで見るようにした。入る vite の版と配布物の挙動は変わらない。 ([#240](https://github.com/pecotcraft/pecot/pull/240), [#236](https://github.com/pecotcraft/pecot/issues/236))
- 配布ツリーの build の順を直し、cli の前で text-rules を build するようにした。 ([#264](https://github.com/pecotcraft/pecot/pull/264), [#245](https://github.com/pecotcraft/pecot/issues/245))
  text-rules の dist が無い checkout でも、配布ツリーを build できる。

- slidev を **53.1.0**、`@vueuse/core` を **15.0.0**、shiki を **4.6.0** に上げた。 ([#169](https://github.com/pecotcraft/pecot/pull/169), [#168](https://github.com/pecotcraft/pecot/issues/168))
  外部のテーマは peer をこの版に合わせる。単体配布は初回に実行時依存を取り直す。

- nx が undici の修正版を宣言したので、`runtime-workspace.yaml` から **undici の override** を外した。 ([#169](https://github.com/pecotcraft/pecot/pull/169), [#168](https://github.com/pecotcraft/pecot/issues/168))
  lock の作り直しで、推移依存の patch 更新も入った。

- vite の版を、pnpm の catalog の 1 か所で決めるようにした。実行用の依存の lock は catalog の項目を持つ。入る vite の版は変わらない。 ([#196](https://github.com/pecotcraft/pecot/pull/196), [#170](https://github.com/pecotcraft/pecot/issues/170))
  単体配布の `setup` は、配布物の実行時依存の manifest に `catalog:` が残っていると、npm を起動せずに配布物の破損として止まる。

- 依存パッケージを 5 件更新。(#172) ([#224](https://github.com/pecotcraft/pecot/pull/224), [#220](https://github.com/pecotcraft/pecot/issues/220))
  `commander` を 15.0.0 から 15.1.0 に更新。
  `dom-to-pptx` を 2.1.1 から 2.1.2 に更新、ほか 3 件。

- references の YAML の違反の場所が、`[/props/foo]` の書式で出るようになった。文言は `must` になった。 ([#204](https://github.com/pecotcraft/pecot/pull/204), [#173](https://github.com/pecotcraft/pecot/issues/173))
  キー名の `/` と `~` は `~1` と `~0` で表す。

- jsdom を 31 に上げた（テスト用の devDependency）。 ([#203](https://github.com/pecotcraft/pecot/pull/203), [#198](https://github.com/pecotcraft/pecot/issues/198))
  lock の作り直しで、推移依存も変わった。

- hooks がエージェントへ返すメッセージを英語にした。行の頭は `error:`・`warning:`・`note:` のどれかになる。 ([#228](https://github.com/pecotcraft/pecot/pull/228), [#209](https://github.com/pecotcraft/pecot/issues/209))
  eslint・validator・textlint が出す文言と、参照の YAML の抜粋は変わらない。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 1.1.0 (2026-11-09)

### 🚀 Features

- `.pecotv/.gitignore` を利用リポで追跡する許可の一覧にし、hook が動く前でも生成物を管理外にする。 ([#137](https://github.com/pecotcraft/pecot/pull/137), [#128](https://github.com/pecotcraft/pecot/issues/128))
  session-start の案内の設定キーは `gitignore-track-notice` に変わる。


### 🩹 Fixes

- Playwright の MCP サーバが、pnpm を宣言したリポジトリで起動しない問題を直した。 ([#140](https://github.com/pecotcraft/pecot/pull/140), [#139](https://github.com/pecotcraft/pecot/issues/139))
  GitHub Copilot CLI では、どのリポジトリでも起動しなかった。
  pecot-workflow にも、同じ Playwright の MCP サーバ `pecot-workflow-playwright` を登録した。

- PPTX 変換の dist 配信サーバの、配信先の外を読ませない判定を、CodeQL が認める書き方へ改めた。 ([#145](https://github.com/pecotcraft/pecot/pull/145), [#142](https://github.com/pecotcraft/pecot/issues/142))
  `//` のように配信先自身を指す要求は、index.html ではなく 404 を返す。変換結果は変わらない。

- リリースのブランドの語の確認を外した。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- Playwright の MCP サーバは、端末に入っている Google Chrome を使う。 ([#114](https://github.com/pecotcraft/pecot/pull/114), [#111](https://github.com/pecotcraft/pecot/issues/111))
  版の合う Chromium を別に取得しなくても、ブラウザ操作のツールが動く。

- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- e2e テストの所要の上限に、環境変数 **`PECOTV_E2E_CEILING_SCALE`** の倍率を掛けられるようにする。配布物の動作は変わらない。 ([#130](https://github.com/pecotcraft/pecot/pull/130), [#129](https://github.com/pecotcraft/pecot/issues/129))
- hook のスクリプトの置き場を変えた参照を直した。 ([#107](https://github.com/pecotcraft/pecot/pull/107), [#64](https://github.com/pecotcraft/pecot/issues/64))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))
- PPTX 変換の dist 配信サーバが、ループバックだけで待ち受け、配信先ディレクトリの外のファイルを返さないようにした。 ([#57](https://github.com/pecotcraft/pecot/pull/57), [#54](https://github.com/pecotcraft/pecot/issues/54))
- Slidev の lint が draw.io の XML からコメントを除く処理を、正規表現からループに替えた。閉じないコメントが続く XML でも、処理の時間が長さに比例して増えるだけになる。 ([#73](https://github.com/pecotcraft/pecot/pull/73), [#58](https://github.com/pecotcraft/pecot/issues/58))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 1.0.0 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
