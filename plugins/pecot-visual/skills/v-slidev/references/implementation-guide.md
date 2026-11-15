# スライド実装ガイド

プランモード完了後、アウトラインに基づきスライドを実装する際のリファレンス。

## 図表作成（1図表 = 1サブエージェント）

アウトライン表で図の枠を持つレイアウトを選んだ枚ごとに、スライド作成に先立ち図表を作成する。

1. **1図表ずつ**Agent toolで`v-diagram-creator`エージェントを並列起動（最大5並列）
2. 全エージェント完了後、出力ファイルの存在を一括確認

**サブエージェント呼び出しプロンプトに含める情報:**

| 情報 | 内容 |
|------|------|
| 図の目的 | 何を伝えるための図か（アウトライン表の主張） |
| 主要要素 | 図に描く要素の全量（アウトライン表の図の中身）。図の文字はこの語だけで書かせる |
| スタイル | 日本語のデッキは `infographic/ja`、英語のデッキは `infographic/en`。AWS・Azure の構成図だけは `aws` / `azure`（`${CLAUDE_PLUGIN_ROOT}/skills/v-drawio/SKILL.md`「用途別スタイルリファレンス」） |
| 表示サイズ | スライドに載せる図。図の外接矩形（線幅を含む）の上限。これを超えると縮小される。寸法は `slide_theme` の `declaration.drawio.panels` の、選んだレイアウトの値（`width` × `height`） |
| 出力パス | `<プレゼンディレクトリ>/public/slides/diagrams/{filename}.drawio` |
| プレゼン全体情報 | タイトル、対象者 |
| 対象スライドの概要 | タイトル・説明内容 |

## slides.md にページを先登録

スライドを作り始める前に、`slides.md` に全ページの `src:` エントリを揃え、root frontmatter に `description:` を指定する。pages ファイル本体は未作成でよい。

```yaml
---
theme: <参照するテーマの名前>
title: ...
description: ...   # 全スライドのヘッダーに伝播
---
<!-- markdownlint-disable -->

---
src: ./pages/title-slide.md
---

---
src: ./pages/overview.md
---
```

## スライド作成（自分で 1 枚ずつ順に作る）

スライドは、アウトラインの順に自分で 1 枚ずつ作る。サブエージェントには任せない。
目次のスライドだけは最後に作る。全スライドの構成が決まってからでないと、スライド番号を正しく書けない。
ページは前後のつながりと語の統一で互いに依存するので、前のページで使った語と主張を踏まえて次を書く。

1 枚ごとに、次の順で進める。

1. `pecot-visual` サーバの `slide_page` を呼ぶ。`layout` はアウトライン表のレイアウト名、`dir` はプレゼンディレクトリの絶対パス、`file` は `pages/` 直下のファイル名にする。
   `<プレゼンディレクトリ>/pages/{file}` に雛形のフロントマターができる
2. 応答の `reference`（レイアウト仕様）と `includes`（`_common` などの共通仕様）を読み切る。
   同じレイアウトの 2 枚目からは、すでに読んだ仕様を使う
3. `reference` の `examples` を元に、そのスライドの内容へ差し替える。ゼロから書かない
4. 雛形のファイルを、作った内容で埋める
5. lint の違反を、その場で直す。違反が残ったまま次のページへ進まない

**書くときの決まり:**

- スライドは YAML フロントマターだけで書く。フロントマターの外に Markdown の本文を書かない
- 生成済みの `---` を二重にしない。末尾に改行を 1 つ入れる
- `text_constraints` を守る。`max_chars` ぎりぎりまで文字を入れる（HTML タグは数えない。タグを除いた全角換算の文字数で判定される）
- 文面は、具体的な事実を短く言い切る。誇張した表現、回りくどい助動詞、同じ助詞の連続、文体の混在を避ける。
  見出しやラベルなどの断片の文には、句点を付けない
- `required: true` の Props は必ず設定する
- `best_practices` に従い、`anti_patterns` を避ける
- 図を持つ枚は、`v-diagram-creator` が作ったファイルのパスを `xmlSrc` に設定するだけにする。
  例: `/slides/diagrams/workflow-overview.drawio`
- コードと HTML は、スライドの価値を大きく左右するので、手を抜かずに作る
- `slide_page` が失敗の応答を返したら、直して再試行せず、失敗の内容をユーザーに伝える

**ファイル命名:** `{英語名}.md`（例: `title-slide.md`）。数字で始めない（`01-title-slide.md` は lint 違反）

## スライド固有アセット

`pecot-visual` サーバの `slide_create`（SKILL.md Step 1 と同じ）が以下を自動生成する。**`slides/` 直下にファイルを置かない。必ずサブディレクトリに入れる。**

```text
public/
  └── slides/
      ├── images/       ← スクリーンショット・写真（src: "/slides/images/xxx.png"）
      ├── diagrams/     ← draw.io図（xmlSrc: "/slides/diagrams/xxx.drawio"）
      └── html/         ← カスタムHTML（iframeContent等で参照）
```

テーマの素材（画像など）は、テーマのパッケージから `/theme/<path>` で配られる。`public/` へ写さない。

## プレビューと出力

**プレビュー確認。** `pecot-visual` サーバの `slide_dev`（`dir`: プレゼンディレクトリの絶対パス）を呼び、
応答の `url` をユーザーに伝えて動作確認を依頼する。停止は `stop: true` で行う。

**PPTX 変換（任意）。** PPTX が必要なときは、`pecot-visual` サーバの `slide_convert`（`project_dir`: プレゼンディレクトリの絶対パス）で生成する。

出力先は `<プレゼンディレクトリ>/pptx/<slides.md の title>.pptx`。title のファイル名不可文字は `_` に正規化する。title が無ければ `<basename>.pptx`。

差分キャッシュは初期状態で有効で、2 回目以降は未変更スライドの変換をスキップする。変更が想定どおり反映されないときは `cache: false` を指定して変換する（詳細は SKILL.md Step 5）。
