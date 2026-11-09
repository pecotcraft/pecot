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
