# 4.0.0 (2026-11-27)

### 🩹 Fixes

- ツールの output が MCP の結果の共通の項目（`kind`・`detail`・`log`・`warnings`）と同じ名前を持つと、ツールの定義で止める。プラグインの動作は変わらない。 ([#775](https://github.com/pecotcraft/pecot/pull/775), [#747](https://github.com/pecotcraft/pecot/issues/747))
- `bin/_lib.sh` の逐語一致の確かめから、`bin/` の無くなった pecot-tools を外した。動作は変わらない。 ([#827](https://github.com/pecotcraft/pecot/pull/827), [#796](https://github.com/pecotcraft/pecot/issues/796))
- Slidev の lint のテストを vitest に移し、使わなくなった c8 を devDependencies から外した。 ([#828](https://github.com/pecotcraft/pecot/pull/828), [#809](https://github.com/pecotcraft/pecot/issues/809))
  runtime-lock.yaml から、使われなくなった @typescript-eslint の古い版を外した。動作は変わらない。

- 開発用の bash のテストが、確かめ 1 つずつ **Allure の結果** を残すようにした。プラグインの動作は変わらない。 ([#829](https://github.com/pecotcraft/pecot/pull/829), [#810](https://github.com/pecotcraft/pecot/issues/810))
- 開発用のテストが、テストレポートに **何を確認したかの説明** を残す。プラグインの動作は変わらない。 ([#842](https://github.com/pecotcraft/pecot/pull/842), [#815](https://github.com/pecotcraft/pecot/issues/815))
- 開発用のテストが、判定で使った **CLI・MCP・hook の出力** を Allure の添付として残す。プラグインの動作は変わらない。 ([#831](https://github.com/pecotcraft/pecot/pull/831), [#816](https://github.com/pecotcraft/pecot/issues/816))

### ⚠️  Breaking Changes

- `bin/` と CLI（`pecotv`）をなくし、MCP のサーバは npm の版を npx で起動する。 ([#841](https://github.com/pecotcraft/pecot/pull/841), [#795](https://github.com/pecotcraft/pecot/issues/795))
  編集の後の確認は MCP のツールを呼ぶフックに替え、GitHub Copilot CLI では動かなくなった。
  データ置き場に残る前の版の `runtime/` は消してかまわない。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 3.1.0 (2026-11-26)

### 🚀 Features

- MCP のすべてのツールが、`tools/list` で表示名（`title`）を返します。 ([#674](https://github.com/pecotcraft/pecot/pull/674), [#643](https://github.com/pecotcraft/pecot/issues/643))

### 🩹 Fixes

- 開発版の MCP の配布は、依存の監査で high 以上が見つかっても警告を出して続ける。本番のリリースは今までどおり止まる。 ([#659](https://github.com/pecotcraft/pecot/pull/659), [#658](https://github.com/pecotcraft/pecot/issues/658))
- 開発用の vitest の設定が、nx のレーンから動いたときに **Allure の結果** も残すようにした。プラグインの動作は変わらない。 ([#719](https://github.com/pecotcraft/pecot/pull/719), [#693](https://github.com/pecotcraft/pecot/issues/693))
- 開発用のテストの `verifies` が、振る舞いの項目の ID を **Allure のリンクと tag** でも残すようにした。プラグインの動作は変わらない。 ([#727](https://github.com/pecotcraft/pecot/pull/727), [#695](https://github.com/pecotcraft/pecot/issues/695))
- 開発用のテストが、判定に使った画面と成果物を **Allure の添付** で残す。プラグインの動作は変わらない。 ([#734](https://github.com/pecotcraft/pecot/pull/734), [#696](https://github.com/pecotcraft/pecot/issues/696))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 3.0.2 (2026-11-18)

### 🩹 Fixes

- GitHub Copilot CLI で、エージェントが使えるツールを**定義のとおり絞る**ようにした。 ([#563](https://github.com/pecotcraft/pecot/pull/563), [#551](https://github.com/pecotcraft/pecot/issues/551))
  w-reviewer は編集のツールを使えず、`/agent` の警告も出ない。

- `.textlintignore`（textlint の標準の除外ファイル）で外したファイルを、`pecot-text-lint` が飛ばすようになった。 ([#566](https://github.com/pecotcraft/pecot/pull/566), [#555](https://github.com/pecotcraft/pecot/issues/555))
  pecot-visual の書くたびの text lint も、リポのルートの `.textlintignore` に従う。

- domain のモジュールのコメントが、**憲法の条を番号ではなく名前（層の分離）**で指すように直した。 ([#601](https://github.com/pecotcraft/pecot/pull/601), [#596](https://github.com/pecotcraft/pecot/issues/596))
- 表を回すテストの題の **`$キー` が読めない形**だと lint が止め、**同じファイルで題が重なる**とテストが止める。 ([#626](https://github.com/pecotcraft/pecot/pull/626), [#606](https://github.com/pecotcraft/pecot/issues/606))
- MCP ツールの出力の型を、ツールごとの**閉じた型**にした。 ([#654](https://github.com/pecotcraft/pecot/pull/654), [#644](https://github.com/pecotcraft/pecot/issues/644))
  pecot-tools は、宣言に無い AWS のキーを外して `warnings` で知らせる。
  `runtime_setup` は、失敗のときに `reason` を返さない。

- Slidev の実行に使う依存の picomatch（4.0.7 以下）に、修正版の無い advisory GHSA-fc5q-39xc-vjpf があります。 ([#666](https://github.com/pecotcraft/pecot/pull/666), [#664](https://github.com/pecotcraft/pecot/issues/664))
  glob のパターンを外から渡せるときの ReDoS で、pecot-visual ではパターンがデッキと設定のファイルからだけ来るため、リリース監査の例外にしました。
  修正版が出たら、依存を上げて例外を外します。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 3.0.1 (2026-11-17)

### 🩹 Fixes

- main の開発版を `@pecot/visual-mcp@next`・`@pecot/tools-mcp@next` で取れるようになりました。 ([#521](https://github.com/pecotcraft/pecot/pull/521), [#504](https://github.com/pecotcraft/pecot/issues/504))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 3.0.0 (2026-11-16)

### 🩹 Fixes

- `eslint` を 10.14.0 から 10.15.0 に更新。 ([#448](https://github.com/pecotcraft/pecot/pull/448), [#446](https://github.com/pecotcraft/pecot/issues/446))
- `XDG_DATA_HOME` が空か相対パスの環境で、**初回の起動が止まる**不具合を修正。 ([#455](https://github.com/pecotcraft/pecot/pull/455), [#452](https://github.com/pecotcraft/pecot/issues/452))

### ⚠️  Breaking Changes

- エージェント `v-slide-creator` を廃止した。v-slidev は、main が全ページを 1 枚ずつ順に作る。 ([#445](https://github.com/pecotcraft/pecot/pull/445), [#444](https://github.com/pecotcraft/pecot/issues/444))
  図は今までどおり `v-diagram-creator` が作る。

- MCP ツールの結果を、MCP の仕様の形にした。`ok`・`exitCode`・`data`・`artifacts`・`message` が無くなった。 ([#441](https://github.com/pecotcraft/pecot/pull/441), [#436](https://github.com/pecotcraft/pecot/issues/436))
  ツールごとの項目は `structuredContent` の最上位、成否は `isError`、失敗は `kind` と `detail` で読む。

- MCP ツールの結果から `stdout` と `stderr` が無くなった。警告は `warnings` に文の配列で入る。 ([#435](https://github.com/pecotcraft/pecot/pull/435), [#433](https://github.com/pecotcraft/pecot/issues/433))
  `drawio_create` と `drawio_export` の `warnings` も、件数ではなく文の配列になった。
  失敗のときの子プロセスの出力は `log` に入る。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 2.0.0 (2026-11-15)

### 🚀 Features

- MCP ツールの失敗の結果に、原因の名前を `kind` で足した。`data.reason` は今までどおり返す。 ([#429](https://github.com/pecotcraft/pecot/pull/429), [#422](https://github.com/pecotcraft/pecot/issues/422))

### 🩹 Fixes

- GitHub Copilot CLI の auto でも、図とスライドを作るエージェントが起きて結果を返す。 ([#425](https://github.com/pecotcraft/pecot/pull/425), [#416](https://github.com/pecotcraft/pecot/issues/416))
- `hono` を 4.13.13 から 4.13.18 に更新。 ([#420](https://github.com/pecotcraft/pecot/pull/420))

### ⚠️  Breaking Changes

- MCP ツール `setup` を `runtime_setup` に改名した。古い名前は使えない。 ([#431](https://github.com/pecotcraft/pecot/pull/431), [#428](https://github.com/pecotcraft/pecot/issues/428))
  許可の設定やスクリプトの `setup` は、`runtime_setup` に書き換える。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

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
