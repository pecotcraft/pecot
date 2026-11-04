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
- `slide_create` / `slide_convert` / `slide_sync` / `slide_dev` は実行時依存を必要とする。未取得の環境では
  `setup` ツールを実行するよう案内する応答が返るので、`pecot-visual` サーバの `setup` を呼んでから再実行する。
- `slide_convert` は Playwright Chromium も必要とする。未取得なら同じく `setup` の案内が返る（約 120MB のダウンロード）。
- `<talk-dir>/node_modules` は `slide_create` 時に項目ごとの symlink を持つ実ディレクトリとして作られる。

## 既存 talk-dir を同期する

`pecot-visual` サーバの `slide_sync` を呼びます。talk-dir の形で動きが分かれます。

- `dir`: talk-dir の絶対パス
- `node_modules_only: true`: node_modules の張り直しのみ行い、ほかは変えない（移行済みの talk-dir では、本体の生成ファイルも今の内容にそろえる）

### テーマを参照する talk-dir（slides.md の `theme:` が package.json の dependencies のテーマを指す）

`package.json` の依存の版でテーマを取得して `node_modules` を張り直します。あわせて、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を本体の今の内容にそろえます。ほかのファイルは変えません。
生成ファイルへの手での編集は残らないので、Vite の追加設定は `setup/vite-plugins.ts` に置いてください。
`node_modules_only` の有無に関わらず同じ動きです。応答の `data.theme` に、張ったテーマの `name` / `spec` / `directory` が入ります。

テーマの版を上げる手順は次のとおりです。

1. `package.json` の依存の `#<tag>` を、上げたい版のタグに書き換える
2. `slide_sync` を `node_modules_only` なしで呼ぶ
3. 起動済みの `slide_dev` は `stop: true` で止め、起動し直す（起動中のサーバは古い版のままのため）

### 旧バージョン生成の talk-dir（テーマを参照しない、`theme: none`）

テーマを参照する形へ移します。`theme` に参照するテーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`）を渡して `slide_sync` を呼びます。
ユーザーが指定していなければ、使うテーマを聞いてから呼びます。`theme` を渡さないと `theme-required` で止まります。

- `slides.md` の `theme:` と `package.json` の依存を、テーマの参照に書き換える
- 旧版のテンプレート由来のファイルとディレクトリを消す。応答の `data.migration.removed` に消した名前が入る
- 利用者作品（`slides.md` の本文 / `pages/` / `public/slides/`）は残る
- 取得に失敗したときは、何も消さずに止まる

移行後の手順は次のとおりです。

1. 応答の `data.migration.removed` をユーザーに伝える
2. 起動済みの `slide_dev` は `stop: true` で止め、起動し直す

`node_modules_only` と `theme` は同時に渡せません。

## 手順（新規プレゼンを作る場合）

### Step 1: プロジェクト生成

`pecot-visual` サーバの `slide_create` を呼びます。

- `project_dir`: 生成先 talk-dir の絶対パス
- `theme`: 参照するテーマの指定（必須）。`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`。ユーザーが指定していなければ、使うテーマを聞いてから呼ぶ（本体はテーマを同梱しない）

scaffold 直後の初期ページは、テーマの参照（`references/`）の examples から作られ、lint クリーンです。

Step 2 へ進む前に、応答の `data.categories` と `data.layouts` を読み切ります。
`data.categories` は見せ方の分類（`id` / `label` / `question`）、
`data.layouts` は選択できるレイアウトの全件です（非公開レイアウトは含まれません）。
`data.layouts` の各要素は `layout` / `description` / `category` / `deprecated` / `filename` を持ちます。
レイアウトの名前と用途は、このスキルには書きません。使えるレイアウトはテーマごとに違うため、必ずこの応答から選びます。
既存の talk-dir を編集するときは、`slide_theme`（`dir`: talk-dir の絶対パス）を呼びます。
`data.categories` と `data.layouts` は `slide_create` の応答と同じ形です。
`slide_theme` の `data` は、ほかに次の項目を持ちます。

- `theme`: 参照しているテーマの `name` / `spec` / `declared`（`pecot-theme.json` の有無）/ `directory` / `linked`
- `declaration`: テーマの宣言。書体（`fonts`）・文字サイズ（`fontSizes`、px）・PPTX の書体とリンク色（`pptx`）を持つ。図の枠を持つレイアウトと寸法（`drawio.panels`）、図に印を求めるレイアウト（`drawio.markerLayouts`）も持つ
- `warnings`: 宣言の欠け（`pptx.linkColor` を省いてリンクを変換しない、など）

### Step 2: プランモード — アウトライン設計

レイアウトは 2 段で決め、計画書にアウトライン表を残します。

1. スライドごとに `data.categories` の `question` に照らして見せ方の分類を 1 つ決める。
   `fixed` は表紙・目次・章扉・参考・裏表紙にだけ使う。本編の締め（まとめ）は `summary` から選ぶ。
   `showpiece` はユーザーが明示的に指示した枚にだけ使い、指示が無い枚では分類の候補にしない。
2. `category` がその分類と一致する `data.layouts` を数え、件数に応じて決める。

- 2 件以上あるときは 2 候補以上を比較して決める
- 1 件のときはその 1 件を採り、比較候補の欄に「層内 1 件」と書く。あわせて分類の選択自体が妥当かを `question` に照らして確認する
- 0 件のときはその枚の主張を `question` に照らして分類から決め直す

アウトライン表は次の列で書きます。

| No | 主張（1 行） | 分類 | レイアウト | 比較候補と選定理由 | 図の中身 |
|----|--------------|------|------------|--------------------|----------|

- 「図の中身」列には、図に描く要素とそのつながりを書く。
  対象は、図の枠を持つレイアウトを選んだ行である。図の枠を持つレイアウトは、`slide_theme` の `data.declaration.drawio.panels` のキーに当たる。それ以外の行は空でかまわない
- 主張が 3 つ以上の要素と、その間のつながり（呼び出し・データの受け渡し・包含・依存・分岐先）で成り立つ枚がある。
  その枚で図の枠を持つレイアウト以外を選ぶときは、「比較候補と選定理由」列に、図の枠を持つレイアウトとの比較を書く。
  時間順に一方向で進む段階だけなら、段階を並べるレイアウトが妥当である。
  同じ観点で属性を比べるなら、表のレイアウトが妥当である。2 者の対比や 1 対 1 の因果なら、左右に対比するレイアウトが妥当である。
  どのレイアウトがそれに当たるかは、`data.layouts[].description` で判断する
- `deprecated: true` のレイアウトは選ばない（品質が水準に達していないため。候補に数えない）
- テーマの `references/<layout>.yaml` の `text_constraints`（`max_chars` / `bold_required`）も踏まえて設計する。talk-dir の `references/` に同名の yaml があれば、そちらが優先される

ユーザーが実施した作業を手順として仕立てる手順書型のプレゼンでは、アウトライン設計を始める前に `references/procedure-outline-guide.md` を読みます。
画面操作手順と CLI 実行手順のどちらでも同じです。

### Step 3: スライド実装

`references/implementation-guide.md` に従います。

1. アウトライン表で図の枠を持つレイアウトを選んだ枚の図を、表の図の中身から `v-diagram-creator` で先に作る（最大 5 並列）
2. `slides.md` に全ページの `src:` エントリを登録（ファイル本体は未作成でよい）
3. `slides.md` の root frontmatter に `description:` を指定（全スライドのヘッダーに伝播）
4. 各スライドを `v-slide-creator` で並列起動（最大 5 並列）。各エージェントは
   `pecot-visual` サーバの `slide_page`（`layout` / `dir` / `file`）でスケルトンページを生成し、
   応答のレイアウト仕様に従って中身を埋める

lint は PostToolUse hook が `pages/**/*.md` および `slides.md` / `references/*.yaml` の
編集時に自動実行します。違反は hook 出力（`additionalContext`）として流れるので、それに従って修正します。
表示文言（reference yaml の `text_constraints` に載る項目）は、文字数のほかに textlint でも確認されます。
AI 臭い言い回し・冗長表現・助詞の連続・文体の混在などは、`text-constraints/textlint` 違反として項目名付きで届きます。
本文と発表者ノートは `text-constraints/textlint-body` が判定し、`本文 L<n>` / `発表者ノート L<n>` の形で返します。n は slides や page ファイルの行番号です。
判定器が動かないときは `textlint を実行できませんでした:` が返ります。
HTML ブロックの中の文は確かめられません。タグの行の直後と閉じタグの前に空行を入れると、中の文が Markdown として判定されます。
空行を入れて Markdown にできない生 HTML の文だけは、ブロックの外に出します。
規則・除外は変えないでください。
指摘された文面はその場で書き直します（同じ違反が残ったまま次のページへ進まない）。
旧形式のデッキを `slide_sync` で移した直後は、旧文面の文面違反がまとめて出ます。
デッキ全体は `pecot-visual` サーバの `slide_lint`（`dir`: talk-dir の絶対パス）で一括 lint できます。
`slide_create` / `slide_sync` の応答では同じ lint 結果が `data.lint` に載ります。

### Step 4: プレビュー

`pecot-visual` サーバの `slide_dev` を呼びます。

- `dir`: talk-dir の絶対パス
- `port`: 起動するポート（省略時は 3030〜3034 の空きを使う。ユーザーから指定があったときだけ渡す）
- `stop: true`: 起動中のプレビューを停止する

応答の `data.url` をユーザーに伝え、ブラウザで確認してもらいます。同じ talk-dir を再度呼ぶと
起動済みのサーバをそのまま返します（`data.reused: true`）。編集内容は HMR で反映されるため、
編集のたびに呼び直す必要はありません。サーバはセッションが終わると停止します。

### Step 5: PPTX 変換（任意）

`pecot-visual` サーバの `slide_convert` を呼びます。

- `project_dir`: talk-dir の絶対パス
- `cache: false`: 差分キャッシュを読まずに全スライドを変換する

結果は応答の `data`（`output` / `timings` / `cache` / `warnings` / `errors`）で確認します。
`stdout` には slidev / vite のビルドログがスライド枚数に比例して流れるため読みません。

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
