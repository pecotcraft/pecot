# @pecot/pecotv-cli

pecot-visual プラグインの MCP サーバ本体です。テーマを参照する Slidev プレゼンの生成・変換・同期、
draw.io XML の URL 化、作業エビデンス xlsx の生成、編集の後の確認を、MCP ツールとして公開します。
本 README には、ツールの inputSchema・description に出ない情報（使い方の文脈・失敗の `kind` の一覧）だけを書きます。

## 起動

`dist/main.js`（npm の package では bin の `pecot-visual-mcp`）が、stdio（stdin / stdout）で待ち受ける MCP サーバを起動します。
引数は読まず、版を出すオプションもありません。サーバの版は `initialize` の `serverInfo.version` で返ります。

MCP サーバ名は `pecot-visual` です。`.mcp.json` の `mcpServers` の登録キーと揃えてあります。
アセット（drawio のアイコン・deck-lint の設定・eslint の規則の dist）は、環境変数ではなくサーバ自身の置き場所から求めます。

実行中の stdout は JSON-RPC が専有します。診断行はすべて stderr へ出ます。

## ツール

| ツール | 内容 |
|---|---|
| `slide_create` | テーマを参照する Slidev プロジェクトを生成する |
| `slide_convert` | talk-dir を PPTX に変換する |
| `slide_sync` | talk-dir の `node_modules` と生成ファイルを本体の今の内容にそろえる |
| `slide_lint` | talk-dir を、テーマの宣言の規則で lint する |
| `slide_theme` | talk-dir が参照するテーマの宣言とレイアウトの一覧を返す |
| `slide_dev` | talk-dir の Slidev dev サーバを起動し、閲覧 URL を返す |
| `slide_page` | 指定レイアウトのスケルトンページを `pages/` に生成し、レイアウトの仕様を返す |
| `drawio_create` | draw.io XML を、ブラウザで開ける HTML と PNG にする |
| `drawio_export` | draw.io XML を SVG・PDF に書き出す |
| `evidence_create` | EvidenceSpec JSON から作業エビデンスの xlsx を生成する |
| `file_lint` / `file_validate` / `file_brief` | 編集したファイルを確かめ、違反をエージェントへの案内にする。PostToolUse のフックが呼ぶ |
| `runtime_setup` | 他のツールの前提となる実行時依存と Chromium を取得する |

### Slidev でプレゼンを作って PPTX で配布する

1. `slide_create` に生成先の `project_dir` とテーマの `theme` を渡す。`theme` は `git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`
2. `slides.md`・`pages/*.md` を編集する（詳細は v-slidev スキルの SKILL.md と Slidev 本家のドキュメント）
3. `slide_convert` に `project_dir` を渡す。`out_path` を省くと、出力は `<project_dir>/pptx/<slides.md の title>.pptx`（title が無ければ `<basename>.pptx`）

`slide_convert` はフォント補正・hyperlink 化・transition 挿入を内部で自動適用します。
書体とリンク色は、テーマの宣言（`pecot-theme.json` の `pptx`）から取ります。
`pptx.eastAsianFont` を省くと東アジア書体を書き込みません。
`pptx.linkColor` を省くとリンクを変換しないため、PPTX にハイパーリンクは 1 つも付きません。
letter-spacing / hyperlink マップは `pptx/slides/` から自動 detect します。
上書きには `spacing_json_path` / `href_json_path` を渡します。
`slide_convert` の `theme` は Slidev の `--theme` に渡す名前で、`slide_create` の `theme`（テーマの指定）とは別物です。

`slide_create` はテンプレートをコピーしません。テーマを `package.json` の `dependencies` に書き、`node_modules` に張ります。
生成するのは `slides.md`・`package.json`・`pages/`・`public/slides/`・`start.mjs`・`vite.config.ts`・`node_modules/` です。
初期ページは、テーマの `references/` の `examples` から作ります。
取得または生成が失敗したときは、生成途中の talk-dir を残しません。`force` で指した既存の生成先は、取得に失敗した場合は消しません。

### 既存の talk-dir を同期する

`slide_sync` は、テーマを参照する talk-dir で、依存の版でテーマを取得して `node_modules` を張り直します。
あわせて、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を本体の今の内容にそろえます。
手での編集は残らないので、Vite の追加設定は `setup/vite-plugins.ts` に置いてください。
テーマの版を上げるには、依存の `#<tag>` を書き換えてから実行します。

テーマを参照しない旧バージョン生成の talk-dir は、`theme` でテーマを指定して移します。
`slides.md` の `theme:` と `package.json` の依存をテーマの参照に書き換え、旧テンプレート由来のファイルとディレクトリを消します。
利用者作品（`slides.md` の本文 / `pages/` / `public/slides/`）は残ります。
`theme` を付けないと `theme-required` で止まります。テーマの取得に失敗したときは、何も消さずに止まります。
`node_modules_only` は `node_modules` の張り直しだけを行い、`theme` とは併用できません。

### draw.io ダイアグラムを URL にする

`drawio_create` は `out_path`（`.html` のみ）へ表示用 HTML を書き出します。HTML を開くと draw.io へリダイレクトします。
PNG も、`out_path` の最後の拡張子を `.png` に置き換えた兄弟ファイルへ書き出します（例: `diagram.drawio.html` → `diagram.drawio.png`）。
PNG は draw.io 公式の XML 埋め込み形式のため、draw.io で開けば再編集できます。ラスター画像だけを配りたいときは `png: false` を渡します。
`icon://` 参照は v-drawio スキルのアイコン（Lucide の SVG）を data URI として埋め込みます。

警告は HTML 検証 / whitespace 検証 / `icon://` 解決 / PNG 生成失敗の 4 系統で、`warnings` に入ります。
PNG の生成に失敗しても URL の書き出しは成功のままで、`pngFailed: true` と警告 1 件になります。
`drawio_export` の PDF も同様に、生成に失敗しても SVG は書き出し、`pdf: null`・`pdfFailed: true` と警告 1 件になります。

### スクリーンショットを作業エビデンスの xlsx にまとめる

`evidence_create` の `input_path` に渡す EvidenceSpec JSON は、タイトル・作成日・追加ヘッダー・画像パス・キャプション・注記を持ちます。
書式は v-evidence スキルの `references/evidence-spec.md` にあります。出力は単一シートの縦並びで、画像は無加工のまま格納されます。

読めない画像・PNG / JPEG 以外の画像は除外されますが、有効画像が 1 件以上あれば成功します。
通し番号は有効画像だけで振り直されるため、欠番は出ません。
除外理由は `not-found`（パスにファイルが無い）/ `unsupported-format`（PNG / JPEG 以外）/ `unreadable`（存在するが読めない）の 3 種です。
除外した画像は、結果の `skipped` に並びます。
`out_path` の親ディレクトリは作らないため、不在のディレクトリを指すと `output-write-failed` になります。

### 編集の後の確認

`file_lint`・`file_validate`・`file_brief` は、`file_path`（編集したファイル）と `cwd`（セッションの作業ディレクトリ）を受けます。
結果は、知らせることが無ければ空の JSON、あれば `hookSpecificOutput.additionalContext` に案内を載せた JSON 1 つです。
フックが結果を読めるよう、失敗しても `isError` は付けず、確かめられなかった理由を案内に書きます。
編集のたびに呼ばれるので、ほかのツールの直列のキューの外で動きます。

## ツール応答の形

ツールの結果は、MCP の仕様どおり `content`・`structuredContent`・`isError` を持ちます。ツールごとの項目は `structuredContent` の最上位に入ります。
成否は `isError` で読み、失敗したときだけ `isError: true` が付きます。失敗の `structuredContent` は、原因の名前の `kind`、文の `detail`、子プロセスの出力の `log` を持ちます。

| 状況 | 結果 | `kind` |
|---|---|---|
| `*_path` / `*_dir` に相対パスを渡した | 失敗（実行前に拒否） | `invalid-path`（該当引数は `invalidPaths`） |
| 実行に失敗した | 失敗 | 下のツールごとの一覧 |
| 依存が未取得 | 失敗 | `chromium-not-installed` / `chromium-install-failed` / `runtime-dependencies-not-installed` |
| `slide_lint` が違反を検出 | 成功 | — |
| `drawio_create` / `drawio_export` が警告を検出 | 成功 | — |

`slide_lint` の違反検出と `drawio_create` / `drawio_export` の警告は、報告そのものが成果なので `isError` は付きません。

**`runtime_setup` が前提になるツール**

- 実行時依存（`runtime_setup` が取得する永続層）が要るのは `slide_create` / `slide_convert` / `slide_sync` の 3 件
- Chromium が要るのは `slide_convert`、`drawio_export`（`print_hash: true` なら不要）、`drawio_create`（PNG 出力時のみ）

## ツールごとの失敗の `kind`

### `slide_create`

| `kind` | 主な原因 |
|---|---|
| `theme-tag-required` / `theme-tag-format` / `theme-semver-range` / `theme-unsupported-spec` | `theme` の形が誤り（タグ無し、タグの書式、範囲指定、解釈できない形） |
| `dest-exists` | 既存ディレクトリで `force` 未指定 |
| `theme-connection` | テーマの取得元に接続できない |
| `theme-auth` | テーマの取得元の認証に失敗（credential helper か SSH 鍵を設定する） |
| `theme-tag` | 取得元に指定のタグが無い |
| `theme-install` | テーマの install・patch の失敗、`file:` のテーマで install 未実施 |
| `theme-unknown` | 上記以外のテーマの取得の失敗（置き場を決められない、`package.json` が無い等） |
| `theme-invalid-shape` | `pecot-theme.json` の形が誤り（誤りの項目名を文言に示す） |
| `theme-unknown-rule` | `pecot-theme.json` の `lint.rules` に本体の知らない規則名がある |
| `symlink-failed` | `node_modules` の組み立ての失敗 |
| `unknown` | その他 |

### `slide_theme`

ネットワークには出ません。成功時は次のキーを返します。

| キー | 内容 |
|---|---|
| `theme` | `name`（パッケージ名）・`spec`（`package.json` の指定）・`declared`（宣言の有無）・`directory`（テーマ root） |
| `declaration` | `pecot-theme.json` の値。省いた項目は既定値で埋める |
| `layouts` / `categories` | レイアウトの一覧と見せ方の分類 |
| `lint` | lint に渡す値の `rules` |
| `warnings` | 宣言が無い、`pptx.linkColor` を省いた、等の警告 |

失敗の `kind` は次の 4 つです。

- `theme-unlinked`: テーマが `node_modules` に張られていない。`slide_sync` に `node_modules_only: true` を渡して張り直す
- `theme-none`: テーマを参照しない移行前の talk-dir
- `theme-invalid-shape`: `pecot-theme.json` の形が誤り
- `theme-unknown-rule`: `lint.rules` に本体の知らない規則名がある

### `slide_convert`

| `kind` | 主な原因 |
|---|---|
| `invalid-theme` | `theme` の値が許容文字外 |
| `project-not-found` | `project_dir` 不在 / `slides.md` 不在 |
| `slidev-build-failed` | `npx slidev build` 失敗 |
| `slidev-build-timeout` | `npx slidev build` が 600 秒超過 |
| `pptx-convert-failed` | in-process pipeline 失敗 |
| `pptx-convert-timeout` | in-process pipeline が 600 秒間進捗なし（スキャン 1 ステップ / スライド 1 ステップの完了が無い）。合計時間の上限は無い |
| `theme-unlinked` / `theme-none` | テーマが `node_modules` に張られていない、テーマを参照しない talk-dir（移行前の形） |
| `theme-connection` / `theme-auth` / `theme-tag` / `theme-install` / `theme-unknown` | 起動時のテーマの取得の失敗（`slide_create` の同名の `kind` と同じ原因と対処） |
| `theme-invalid-shape` / `theme-unknown-rule` | `pecot-theme.json` の誤り |
| `invalid-staging-json` | letter-spacing / hyperlink JSON が読めない / 形式不正 |
| `merge-failed` | 単スライド PPTX の結合・出力の失敗（`out_path` が書けない等） |
| `unknown` | その他 |

### `drawio_create`

| `kind` | 主な原因 |
|---|---|
| `invalid-output-extension` | `out_path` の拡張子が `.html` 以外 |
| `input-not-found` | 入力ファイルが読めない |
| `output-write-failed` | 出力ファイルの書き出し失敗 |
| `unknown` | その他 |

### `evidence_create`

| `kind` | 主な原因 |
|---|---|
| `input-not-found` | 入力ファイルが読めない |
| `invalid-json` | spec JSON の parse 失敗 |
| `invalid-spec` | spec の検証エラー |
| `no-valid-images` | 有効画像 0 件（xlsx は書き出さない） |
| `output-write-failed` | 出力 xlsx の書き出し失敗 |
| `unknown` | その他 |

## 開発

コマンドと手順はプラグインの [README](../README.md) に記載しています。
