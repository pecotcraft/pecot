---
name: v-slidev
description: |
  Slidev でプレゼンテーションを新規作成・編集・PPTX 変換します。
  Use when the user works on a Slidev deck — scaffolds a standalone talk-dir that references a Slidev theme (git URL with a tag, or a local path) in any repo, or moves an existing talk-dir onto a theme. Triggers: "Slidev", "スライド作成", "スライド編集", "talk-dir の同期", "PPTX 変換", "プレゼン出力".
  Do NOT use for standalone diagrams (use v-drawio) or screenshot evidence xlsx (use v-evidence).
when_to_use: "スライドを作りたい、プレゼン資料を編集・PPTX にしたい、既存デッキをテーマ参照に移したい"
argument-hint: "[スライドの内容 または 既存デッキのパス]"
---

# Slidev プレゼンテーション作成

このスキルが扱うのは Slidev プロジェクトの生成・アウトライン設計・`pages/*.md` と `slides.md`
の編集・PPTX 変換です。`layouts/` や `components/` の改修はスコープ外です（参照するテーマのリポジトリへの
PR で対応します）。既存 talk-dir のテーマの版上げと移行には `pecot-visual` サーバの `slide_sync` を使います。

## 前提条件

- パス引数（`project_dir` / `dir` / `input_path`）はすべて絶対パスで渡す。相対パスは実行前に拒否される。
- `pecot-visual` サーバの `slide_create` / `slide_convert` / `slide_sync` / `slide_dev` は実行時依存を必要とする。未取得の環境では
  `runtime_setup` を実行するよう案内する応答が返るので、`pecot-visual` サーバの `runtime_setup` を呼んでから再実行する。
- `slide_convert` は Playwright Chromium も必要とする。未取得なら同じく `runtime_setup` の案内が返る（約 120MB のダウンロード）。
- `<talk-dir>/node_modules` は `slide_create` 時に項目ごとの symlink を持つ実ディレクトリとして作られる。

## 既存 talk-dir を同期する

`pecot-visual` サーバの `slide_sync` を使って、talk-dir を同期します。talk-dir の形で動きが分かれます。
node_modules の張り直しだけをしたいときは、`node_modules_only: true` を渡します。

### テーマを参照する talk-dir（slides.md の `theme:` が package.json の dependencies のテーマを指す）

`package.json` の依存の版でテーマを取得して `node_modules` を張り直します。あわせて、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を本体の今の内容にそろえます。ほかのファイルは変えません。
生成ファイルへの手での編集は残らないので、Vite の追加設定は `setup/vite-plugins.ts` に置いてください。
`node_modules_only` の有無に関わらず同じ動きです。

テーマの版を上げる手順は次のとおりです。

1. `package.json` の依存の `#<tag>` を、上げたい版のタグに書き換える
2. `slide_sync` を使う（`node_modules_only` なし）
3. 起動済みの `slide_dev` は `stop: true` で止め、起動し直す（起動中のサーバは古い版のままのため）

### 旧バージョン生成の talk-dir（テーマを参照しない、`theme: none`）

テーマを参照する形へ移します。`theme` に参照するテーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`）を渡して `slide_sync` を使います。
ユーザーが指定していなければ、使うテーマを先に聞きます。

- `slides.md` の `theme:` と `package.json` の依存を、テーマの参照に書き換える
- 旧版のテンプレート由来のファイルとディレクトリを消す
- 利用者作品（`slides.md` の本文 / `pages/` / `public/slides/`）は残る
- 取得に失敗したときは、何も消さずに止まる

移行後の手順は次のとおりです。

1. 消したファイルとディレクトリの名前をユーザーに伝える
2. 起動済みの `slide_dev` は `stop: true` で止め、起動し直す

## 手順（新規プレゼンを作る場合）

### Step 1: プロジェクト生成

`pecot-visual` サーバの `slide_create` を使って、talk-dir を作ります。
`theme` には参照するテーマを渡します。`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`。ユーザーが指定していなければ、使うテーマを先に聞きます（本体はテーマを同梱しない）。

scaffold 直後の初期ページは、テーマの参照（`references/`）の examples から作られ、lint クリーンです。

Step 2 へ進む前に、結果のレイアウトの分類と一覧を読み切ります。
使えるレイアウトはテーマごとに違うため、必ずこの結果から選びます。
既存の talk-dir を編集するときは、`pecot-visual` サーバの `slide_theme` を使って、同じ一覧とテーマの宣言（書体・文字サイズ・図の枠の寸法）を読みます。

- `warnings`: 宣言の欠け（`pptx.linkColor` を省いてリンクを変換しない、など）

### Step 2: プランモード — アウトライン設計

レイアウトは 2 段で決め、計画書にアウトライン表を残します。

1. スライドごとに `categories` の `question` に照らして見せ方の分類を 1 つ決める。
   `fixed` は表紙・目次・章扉・参考・裏表紙にだけ使う。本編の締め（まとめ）は `summary` から選ぶ。
   `showpiece` はユーザーが明示的に指示した枚にだけ使い、指示が無い枚では分類の候補にしない。
2. `category` がその分類と一致する `layouts` を数え、件数に応じて決める。

- 2 件以上あるときは 2 候補以上を比較して決める
- 1 件のときはその 1 件を採り、比較候補の欄に「層内 1 件」と書く。あわせて分類の選択自体が妥当かを `question` に照らして確認する
- 0 件のときはその枚の主張を `question` に照らして分類から決め直す

アウトライン表は次の列で書きます。

| No | 主張（1 行） | 分類 | レイアウト | 比較候補と選定理由 | 図の中身 |
|----|--------------|------|------------|--------------------|----------|

- 「図の中身」列には、図に描く要素とそのつながりを書く。
  対象は、図の枠を持つレイアウトを選んだ行である。図の枠を持つレイアウトは、`slide_theme` の `declaration.drawio.panels` のキーに当たる。それ以外の行は空でかまわない
- 主張が 3 つ以上の要素と、その間のつながり（呼び出し・データの受け渡し・包含・依存・分岐先）で成り立つ枚がある。
  その枚で図の枠を持つレイアウト以外を選ぶときは、「比較候補と選定理由」列に、図の枠を持つレイアウトとの比較を書く。
  時間順に一方向で進む段階だけなら、段階を並べるレイアウトが妥当である。
  同じ観点で属性を比べるなら、表のレイアウトが妥当である。2 者の対比や 1 対 1 の因果なら、左右に対比するレイアウトが妥当である。
  どのレイアウトがそれに当たるかは、`layouts[].description` で判断する
- `deprecated: true` のレイアウトは選ばない（品質が水準に達していないため。候補に数えない）
- テーマの `references/<layout>.yaml` の `text_constraints`（`max_chars` / `bold_required`）も踏まえて設計する。talk-dir の `references/` に同名の yaml があれば、そちらが優先される

ユーザーが実施した作業を手順として仕立てる手順書型のプレゼンでは、アウトライン設計を始める前に `references/procedure-outline-guide.md` を読みます。
画面操作手順と CLI 実行手順のどちらでも同じです。

### Step 3: スライド実装

`references/implementation-guide.md` に従います。

1. アウトライン表で図の枠を持つレイアウトを選んだ枚の図を、表の図の中身から `v-diagram-creator` で先に作る（最大 5 並列）。
   図の作成は XML とスタイルリファレンスを大量に読み書きし、返すのはファイルのパスだけなので、サブエージェントに任せる
2. `slides.md` に全ページの `src:` エントリを登録（ファイル本体は未作成でよい）
3. `slides.md` の root frontmatter に `description:` を指定（全スライドのヘッダーに伝播）
4. 各スライドを、自分で 1 枚ずつ順に作る。サブエージェントには任せない。
   ページは前後のつながりと語の統一で互いに依存するので、アウトラインを持つ自分が通して書く。
   1 枚ごとの手順と書くときの決まりは、`references/implementation-guide.md` の「スライド作成」にある

lint は PostToolUse hook が `pages/**/*.md` および `slides.md` / `references/*.yaml` の
編集時に自動実行します。違反は hook 出力（`additionalContext`）として流れるので、それに従って修正します。
表示文言（reference yaml の `text_constraints` に載る項目）は、文字数のほかに textlint でも確認されます。
AI 臭い言い回し・冗長表現・助詞の連続・文体の混在などは、`text-constraints/textlint` 違反として項目名付きで届きます。
本文と発表者ノートは `text-constraints/textlint-body` が判定し、`body L<n>` / `speaker notes L<n>` の形で返します。n は slides や page ファイルの行番号です。
判定器が動かないときは `textlint failed to run:` が返ります。
HTML ブロックの中の文は確かめられません。タグの行の直後と閉じタグの前に空行を入れると、中の文が Markdown として判定されます。
空行を入れて Markdown にできない生 HTML の文だけは、ブロックの外に出します。
規則・除外は変えないでください。
指摘された文面はその場で書き直します（同じ違反が残ったまま次のページへ進まない）。
旧形式のデッキを `slide_sync` で移した直後は、旧文面の文面違反がまとめて出ます。
デッキ全体は `pecot-visual` サーバの `slide_lint`（`dir`: talk-dir の絶対パス）で一括 lint できます。

### Step 4: プレビュー

`pecot-visual` サーバの `slide_dev` を使って、プレビューを起動します。`port` は、ユーザーから指定があったときだけ渡します。

プレビューの URL をユーザーに伝え、ブラウザで確認してもらいます。編集内容は HMR で反映されるため、
編集のたびに起動し直す必要はありません。止めるときは `stop: true` を渡します。

### Step 5: PPTX 変換（任意）

`pecot-visual` サーバの `slide_convert` を使って、PPTX に変換します。全スライドを変換し直すときは、`cache: false` を渡します。

書き出した PPTX のパスと警告を、ユーザーに伝えます。

出力先は `<talk-dir>/pptx/<slides.md の title>.pptx` です。title のファイル名不可文字は `_` に正規化されます。title が無ければ `<talk-dir の basename>.pptx` になります。
convert 内でフォント補正・hyperlink 化・transition 挿入が自動適用されます。

テンプレートの装飾目的の CSS アニメーションは pptx へ持ち込みません（PowerPoint のスライドショーで対象が初期非表示になり、クリックしないと出そろわないため）。
要素に出現アニメーションを付けたいときは、その要素へ `data-pptx-animation` を指定します。
値は `fade-in` / `zoom-in` / `fly-in` / `wipe-in` などです。`data-pptx-animation-duration` で尺をミリ秒指定できます。
判定はスライド単位です。明示指定を 1 つでも置いたスライドは、そのスライドの装飾分のアニメーションも一緒に残ります。

差分キャッシュは初期状態で有効です。2 回目以降の変換は未変更スライドの変換をスキップします（キャッシュは `<talk-dir>/pptx/cache/` に保存されます）。
`cache: false` を指定してもキャッシュは完了時に再構築されます。

次のケースは変更が検知されないため、`cache: false` で変換します。

- `public/` 配下のアセットをファイル名そのままで差し替えた場合（画像だけを入れ替えたときなど）
- talk-dir の自作レイアウトや本文が `<Toc>` や `$slidev.nav.total` などデッキ構造由来の内容を描画している場合

## リファレンス

| パス | 用途 |
|------|------|
| `references/procedure-outline-guide.md` | 手順書型プレゼンのアウトライン設計（Step 2）— 画面操作手順 / CLI 実行手順の使い分け・骨格・手順ページ・参考リンク（このスキルと同階層） |
| `references/implementation-guide.md` | 図表作成・スライド実装の詳細手順（このスキルと同階層） |
| `references/*.yaml`（テーマの置き場、または talk-dir） | Step 2 の横断参照用（全レイアウトの text_constraints を見比べる）。Step 3 の 1 レイアウト分は `slide_page` の応答で受け取ります |
