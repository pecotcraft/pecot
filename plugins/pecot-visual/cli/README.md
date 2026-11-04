# @pecot/pecotv-cli

Node 製 CLI。テーマを参照する Slidev プレゼンの生成・変換・同期、
draw.io XML の URL 化、作業エビデンス xlsx の生成を提供します。
各サブコマンドの全オプションと default 値は `pecotv <cmd> --help` で確認できます。
本 README には `--help` に出ない情報（ユースケース文脈・`--json` の reason 一覧）のみ記載します。

## できること

- テーマを参照する Slidev プロジェクトの生成・PPTX 変換 (`slide create` / `slide convert` / `slide sync`)
- talk-dir が参照するテーマの宣言とレイアウトの一覧の確認 (`slide theme`)
- draw.io XML をブラウザで開ける URL に変換 (`drawio url`)
- EvidenceSpec JSON から作業エビデンスの xlsx を生成 (`evidence create`)
- 上記の機能を MCP ツールとして提供する stdio MCP サーバを起動 (`mcp`)

## ユースケース別の使い方

### Slidev でプレゼンを作って PPTX で配布する

```bash
# 1. プロジェクト生成（位置引数。--theme は必須。git URL にはタグを付ける）
pecotv slide create ./talk --theme git+https://example.com/org/theme.git#v1.0.0

# 2. ./talk/slides.md / pages/*.md を編集
#    （詳細は v-slidev スキルの SKILL.md / Slidev 本家ドキュメント参照）

# 3. PPTX 変換（省略時の出力名は slides.md の title 由来。title 不在時は ./talk/pptx/talk.pptx）
pecotv slide convert ./talk
```

`slide convert` はフォント補正・hyperlink 化・transition 挿入を内部で自動適用します。
書体とリンク色は、テーマの宣言（`pecot-theme.json` の `pptx`）から取ります。
`pptx.eastAsianFont` を省くと東アジア書体を書き込みません。
`pptx.linkColor` を省くとリンクを変換しないため、PPTX にハイパーリンクは 1 つも付きません。
letter-spacing / hyperlink マップは `pptx/slides/` から自動 detect します
（上書きには `--spacing-json` / `--href-json`）。
transition を変えたい場合は `--transition-type morph` 等を指定します。

### 既存の talk-dir を同期する

```bash
pecotv slide sync --dir ./talk
```

テーマを参照する talk-dir では、依存の版でテーマを取得して `node_modules` を張り直します。
テーマを参照する talk-dir とは、`slides.md` の `theme:` が `package.json` の依存のテーマを指す形です。
あわせて、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を本体の今の内容にそろえます。
手での編集は残らないので、Vite の追加設定は `setup/vite-plugins.ts` に置いてください。
ほかのファイルは変えません。
テーマの版を上げるには、依存の `#<tag>` を書き換えてから実行します。

旧バージョン生成の talk-dir（テーマを参照しない）は、`--theme` でテーマを指定して移します。

```bash
pecotv slide sync --dir ./talk --theme 'git+https://<host>/<owner>/<repo>.git#<tag>'
```

`slides.md` の `theme:` と `package.json` の依存をテーマの参照に書き換え、旧テンプレート由来のファイルとディレクトリを消します。
消した名前は結果に出ます。
利用者作品（`slides.md` の本文 / `pages/` / `public/slides/`）は残ります。
`--theme` を付けないと `theme-required` で止まります。
テーマの取得に失敗したときは、何も消さずに止まります。

node_modules だけ張り直したい場合:

```bash
pecotv slide sync --dir ./talk --node-modules-only
```

### draw.io ダイアグラムを URL にする

```bash
pecotv drawio url diagram.drawio
pecotv drawio url diagram.drawio -o diagram.drawio.html
```

`-o` 未指定時は URL を 1 行 stdout 出力します。
`-o <path>` 指定時は `<path>` へ表示用 HTML を書き出し、stdout は静かになります。
HTML はダブルクリックすると既定ブラウザで開き、draw.io へリダイレクトします。
人間向けメッセージは stderr に `wrote HTML to <path>` を 1 行出します。
`-o` に渡せる拡張子は `.html` だけで、それ以外は exit 2 で終了しファイルを書き出しません。
`-o` 指定時は PNG も同時に出力します。
PNG は `<path>` の最後の拡張子を `.png` に置換した兄弟ファイルです。
例は `diagram.drawio.html` → `diagram.drawio.png` です。
draw.io 公式の XML 埋め込み PNG 形式のため、draw.io で開けば再編集できます。
PNG は図の XML ソースを内包するため、ラスター画像のみを配布したい場合は `--no-png` を付けます。
`icon://` 参照は v-drawio スキルのアイコン（Lucide の SVG）を data URI として埋め込みます。
`--mode view|edit` を受理しますが生成 URL は同一（v1.0.0 仕様互換のための no-op）。

`--json` と併用した場合の成功 payload は `-o` / `--no-png` の指定で変わります。

- `-o` 指定時（既定、PNG も出力）:
  `{"event":"drawio.url.done","file":"<abs path>","png":"<abs path>","pngFailed":false,"warnings":0}`
- `-o` + `--no-png`: `{"event":"drawio.url.done","file":"<abs path>","warnings":0}`
- `-o` 未指定: `{"event":"drawio.url.done","url":"<url>","warnings":0}`

PNG の生成に失敗しても URL の書き出しは成功扱いのままで、`png` が `null`、`pngFailed` が `true` になり `warnings` が 1 増えます。

### スクリーンショットを作業エビデンスの xlsx にまとめる

```bash
pecotv evidence create --input spec.json --out evidence.xlsx
```

`--input` に渡す EvidenceSpec JSON は、タイトル・作成日・追加ヘッダー・画像パス・キャプション・注記を持ちます。
書式は v-evidence スキルの `references/evidence-spec.md` にあります。出力は単一シートの縦並びで、
画像は無加工のまま格納されます。通常はこのスキル経由で使い、CLI 直接実行は spec を手書きする場合です。

読めない画像・PNG / JPEG 以外の画像は除外されますが、有効画像が 1 件以上あれば exit 0 で成功します。
通し番号は有効画像だけで振り直されるため、欠番は出ません。
除外理由は次の 3 種です。
`not-found`（パスにファイルが無い）/ `unsupported-format`（PNG / JPEG 以外）/ `unreadable`（存在するが読めない）。
これらは `--json` の `result` イベントに列挙されます。有効画像が 0 件のときだけ `no-valid-images` で失敗し xlsx は書き出しません。

```json
{"event":"result","outPath":"/abs/path/evidence.xlsx","items":5,"annotations":3,
 "skipped":[{"path":"/abs/path/broken.png","reason":"unreadable"}]}
```

`--input` / `--out` はプロセスの cwd 基準で解決し、`outPath` は絶対パスで返します。
`--out` の親ディレクトリは CLI が作らないため、不在のディレクトリを指すと `output-write-failed` になります
（先に `mkdir -p` してください）。

## subcommand 仕様

### `pecotv slide create <project-dir>`

テンプレートはコピーしません。`--theme` で指定したテーマを `package.json` の `dependencies` に書き、`node_modules` に張ります。
生成するのは次のものだけです。
`slides.md`・`package.json`・`pages/` の初期ページ・`public/slides/`・`start.mjs`・`vite.config.ts`・`node_modules/` です。
テーマの layouts・components・styles・`public/assets`・`pages/_references` は、talk-dir にコピーしません。
初期ページは、テーマの `references/` の `examples` から作ります。

| 引数 / オプション | 説明 |
|---|---|
| `<project-dir>` | 生成先ディレクトリ（必須、位置引数） |
| `--theme <spec>` | テーマの指定（必須）。`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<path>`。タグの無い git URL は受け付けない。`file:` の相対パスは cwd 基準 |
| `--force` | 既存ディレクトリを上書き |
| `--json` | machine-readable JSON を stdout へ |

`slide convert --theme <name>` は Slidev の `--theme` に渡す名前で、この `--theme` とは別物です。

**`--json` エラー時の reason 一覧**

| reason | 終了コード | 主な原因 |
|---|---:|---|
| `invalid-option` | 2 | 引数検証エラー（`--theme` の省略を含む） |
| `theme-tag-required` / `theme-tag-format` / `theme-semver-range` / `theme-unsupported-spec` | 2 | `--theme` の形が誤り（タグ無し、タグの書式、範囲指定、解釈できない形） |
| `dest-exists` | 2 | 既存ディレクトリで `--force` 未指定 |
| `theme-connection` | 1 | テーマの取得元に接続できない |
| `theme-auth` | 1 | テーマの取得元の認証に失敗（credential helper か SSH 鍵を設定する） |
| `theme-tag` | 1 | 取得元に指定のタグが無い |
| `theme-install` | 1 | テーマの install・patch の失敗、`file:` のテーマで install 未実施 |
| `theme-unknown` | 1 | 上記以外のテーマの取得の失敗（置き場を決められない、`package.json` が無い等） |
| `theme-invalid-shape` | 1 | `pecot-theme.json` の形が誤り（誤りの項目名を文言に示す） |
| `theme-unknown-rule` | 1 | `pecot-theme.json` の `lint.rules` に本体の知らない規則名がある |
| `symlink-failed` | 1 | `node_modules` の組み立ての失敗 |
| `unknown` | 1 | その他 |

取得または生成が失敗したときは、生成途中の talk-dir を残しません。
`--force` で指した既存の生成先は、取得に失敗した場合は消しません。

### `pecotv slide theme [--dir <path>]`

talk-dir が参照するテーマの宣言とレイアウトの一覧を返します。ネットワークには出ません。

| オプション | 説明 |
|---|---|
| `--dir <path>` | talk-dir（省略時はカレント） |
| `--json` | machine-readable JSON を stdout へ |

`--json` の成功時は `slide.theme.done` で、次のキーを返します。

| キー | 内容 |
|---|---|
| `theme` | `name`（パッケージ名）・`spec`（`package.json` の指定）・`declared`（宣言の有無）・`directory`（テーマ root） |
| `declaration` | `pecot-theme.json` の値。省いた項目は既定値で埋める |
| `layouts` / `categories` | レイアウトの一覧と見せ方の分類 |
| `lint` | lint に渡す値（`referencesDirectories`・`panels`・`markerLayouts`・`rules`） |
| `warnings` | 宣言が無い、`pptx.linkColor` を省いた、等の警告 |

失敗時の reason は次の 4 つです。

- `theme-unlinked`: テーマが `node_modules` に張られていない。`slide sync --node-modules-only` で張り直す
- `theme-none`: テーマを参照しない移行前の talk-dir
- `theme-invalid-shape`: `pecot-theme.json` の形が誤り
- `theme-unknown-rule`: `lint.rules` に本体の知らない規則名がある

### `pecotv slide convert <project-dir> [--out <path>]`

| 引数 / オプション | 説明 |
|---|---|
| `<project-dir>` | Slidev プロジェクトディレクトリ（必須、位置引数） |
| `--out <path>` | 出力 PPTX path（省略時: `<project-dir>/pptx/<slides.md の title>.pptx`、title 不在時は `<basename>.pptx`。title のファイル名不可文字は `_` に正規化） |
| `--theme <name>` | `npx slidev build` に渡す theme 名（`slide create --theme` のテーマの指定とは別物） |
| `--spacing-json <path>` | letter-spacing JSON（省略時は staging から auto-detect） |
| `--href-json <path>` | hyperlink JSON（省略時は staging から auto-detect） |
| `--transition-type <type>` | `fade` または `morph` |
| `--transition-duration-ms <ms>` | transition の duration |
| `--morph-option <option>` | `byObject` / `byWord` / `byChar` |
| `--json` | machine-readable JSON を stdout へ |

**`--json` エラー時の reason 一覧**

| reason | 終了コード | 主な原因 |
|---|---:|---|
| `invalid-option` | 2 | 引数検証エラー |
| `invalid-theme` | 2 | `--theme` 値が許容文字外 |
| `project-not-found` | 1 | `<project-dir>` 不在 / `slides.md` 不在 |
| `slidev-build-failed` | 1 | `npx slidev build` 失敗 |
| `slidev-build-timeout` | 1 | `npx slidev build` が 600 秒超過 |
| `pptx-convert-failed` | 1 | in-process pipeline 失敗 |
| `pptx-convert-timeout` | 1 | in-process pipeline が 600 秒間進捗なし（スキャン 1 ステップ / スライド 1 ステップの完了が無い）。合計時間の上限は無い |
| `theme-unlinked` / `theme-none` | 1 | テーマが `node_modules` に張られていない、テーマを参照しない talk-dir（移行前の形） |
| `theme-connection` / `theme-auth` / `theme-tag` / `theme-install` / `theme-unknown` | 1 | 起動時のテーマの取得の失敗（`slide create` の同名 reason と同じ原因と対処） |
| `theme-invalid-shape` / `theme-unknown-rule` | 1 | `pecot-theme.json` の誤り |
| `invalid-staging-json` | 1 | letter-spacing / hyperlink JSON が読めない / 形式不正 |
| `merge-failed` | 1 | 単スライド PPTX の結合・出力の失敗（`--out` が書けない等） |
| `unknown` | 1 | その他 |

### `pecotv slide sync --dir <path>`

| オプション | 説明 |
|---|---|
| `--dir <path>` | 同期対象 talk-dir（必須） |
| `--theme <spec>` | 旧バージョン生成の talk-dir を、このテーマを参照する形へ移す。`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`。`--node-modules-only` とは併用できない |
| `--node-modules-only` | node_modules の張り直しのみ。`package.json` のテーマを取得（取得済みならネットワークには出ない）して張る。テーマを参照する talk-dir では、生成ファイル（`vite.config.ts`・`start.mjs`）も本体の今の内容にそろえる。通常の sync も同じ動き |
| `--json` | machine-readable JSON を stdout へ |

### `pecotv drawio url <input>`

| 引数 / オプション | 説明 |
|---|---|
| `<input>` | 入力 `.drawio` ファイル path（必須、位置引数） |
| `-o, --output <path>` | 表示用 HTML の書き出し先ファイル path（`.html` のみ受理）。指定時は stdout から URL を抑止し、PNG も同時に出力する |
| `--no-png` | `-o` 指定時の PNG 同時出力を抑止（既定は PNG も出力） |
| `--mode <mode>` | `view` または `edit`（v1.0.0 仕様互換の no-op。生成 URL は同一） |
| `--json` | machine-readable JSON を stdout へ |

PNG は `-o <path>` の最後の拡張子を `.png` に置換した兄弟ファイルとして書き出します。
`diagram.drawio.html` のような多重拡張子でも、置換されるのは末尾の `.html` だけです。

警告が 1 件以上あると exit 3 で終了します。これは成功パスで、`--json` の payload は
`event: "drawio.url.done"` のまま `warnings` に件数が入ります。警告は HTML 検証 /
whitespace 検証 / `icon://` 解決 / PNG 生成失敗の 4 系統で、内訳は stderr に 1 行ずつ出ます。

**`--json` エラー時の reason 一覧**

| reason | 終了コード | 主な原因 |
|---|---:|---|
| `invalid-option` | 2 | 引数検証エラー（引数欠落 / 不明オプション） |
| `invalid-mode` | 2 | `--mode` 値が `view` / `edit` 以外 |
| `invalid-output-extension` | 2 | `-o` の拡張子が `.html` 以外 |
| `input-not-found` | 1 | 入力ファイルが読めない |
| `output-write-failed` | 1 | `-o` 指定時の出力ファイル書き出し失敗 |
| `unknown` | 1 | その他 |

### `pecotv evidence create --input <path>`

| 引数 / オプション | 説明 |
|---|---|
| `--input <path>` | EvidenceSpec JSON の path（必須） |
| `--out <path>` | 出力 xlsx path（default: `./evidence.xlsx`。既存ファイルは上書き） |
| `--json` | machine-readable JSON を stdout へ |

**`--json` エラー時の reason 一覧**

| reason | 終了コード | 主な原因 |
|---|---:|---|
| `invalid-option` | 2 | 引数検証エラー |
| `input-not-found` | 1 | 入力ファイルが読めない |
| `invalid-json` | 1 | spec JSON の parse 失敗 |
| `invalid-spec` | 1 | spec の検証エラー |
| `no-valid-images` | 1 | 有効画像 0 件（xlsx は書き出さない） |
| `output-write-failed` | 1 | 出力 xlsx の書き出し失敗 |
| `unknown` | 1 | その他 |

### `pecotv mcp`

stdio（stdin / stdout）で待ち受ける MCP サーバとして起動します。サーバ名は `pecot-visual` です。
引数・オプションはありません。MCP クライアントの設定にコマンドとして登録して使います。

**公開ツールと対応 CLI コマンド**

| ツール | 対応 CLI コマンド |
|---|---|
| `slide_create` | `pecotv slide create` |
| `slide_convert` | `pecotv slide convert` |
| `slide_sync` | `pecotv slide sync` |
| `slide_lint` | `pecotv slide lint` |
| `slide_theme` | `pecotv slide theme` |
| `slide_dev` | 対応 CLI なし（talk-dir の Slidev dev サーバを起動し閲覧 URL を返す） |
| `slide_page` | 対応 CLI なし（指定レイアウトのスケルトンページを `pages/` 配下に生成し、レイアウト仕様を返す） |
| `drawio_create` | `pecotv drawio url` |
| `drawio_export` | `pecotv drawio export` |
| `evidence_create` | `pecotv evidence create` |
| `setup` | 対応 CLI なし（他ツールの前提となる実行時依存と Chromium を取得する） |

`slide lint` / `pptx preview` / `drawio export` は本 README に節がありません。引数・オプションは
`pecotv <cmd> --help` で確認してください。

**MCP 応答の exitCode**

ツールの応答は `ok` / `exitCode` / `artifacts` / `data` / `message` を持ちます。`ok` は目的の実行を
完了できたかだけを表し、`ok: false` のときだけ MCP の `isError: true` が付きます。`exitCode` は
対応する CLI コマンドの終了コード規約と同じ値です。

| 状況 | `ok` | `exitCode` | `data.reason` |
|---|---|---|---|
| `*_path` / `*_dir` に相対パスを渡した | false | 2（実行前に拒否） | なし（該当引数は `data.invalidPaths`） |
| 実行に失敗した | false | 各コマンドの reason 一覧と同じ値 | 各コマンドの reason 一覧と同じ値 |
| 依存が未取得 | false | 1 | `chromium-not-installed` / `chromium-install-failed` / `runtime-dependencies-not-installed` |
| `slide_lint` が違反を検出 | true | 1 | — |
| `drawio_create` / `drawio_export` が警告を検出 | true | 3 | — |

`slide_lint` の違反検出と `drawio_create` / `drawio_export` の警告は報告そのものが成果なので `isError` は付きません。
`evidence_create` の実行失敗時 `exitCode` は 1 です。
相対パス拒否の 2 は上表のとおりです。
CLI の `invalid-option` による 2 は inputSchema の検証が先に済ませるため、MCP 経由では出ません。
`drawio_create` の PNG 出力だけは、Chromium が未取得でも URL の書き出しが成立します。
そのため失敗ではなく、警告 1 件（`exitCode` 3 / `pngFailed: true`）として返ります。
`drawio_export` の PDF も同様に、生成に失敗しても SVG は書き出します。
その場合は警告 1 件（`exitCode` 3 / `pdf: null` / `pdfFailed: true`）として返ります。

**`setup` が前提になるツール**

- 実行時依存（`setup` が取得する永続層）が要るのは `slide_create` / `slide_convert` / `slide_sync` の 3 件
- Chromium が要るのは `slide_convert`、`drawio_export`（`print_hash: true` なら不要）、`drawio_create`（PNG 出力時のみ）
