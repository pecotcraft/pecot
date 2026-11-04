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
| 表示サイズ | スライドに載せる図。図の外接矩形（線幅を含む）の上限。これを超えると縮小される。寸法は `slide_theme` の `data.declaration.drawio.panels` の、選んだレイアウトの値（`width` × `height`） |
| 出力パス | `<プレゼンディレクトリ>/public/slides/diagrams/{filename}.drawio` |
| プレゼン全体情報 | タイトル、対象者 |
| 対象スライドの概要 | タイトル・説明内容 |

## slides.md にページを先登録

`v-slide-creator` を起動する前に、`slides.md` に全ページの `src:` エントリを揃え、root frontmatter に `description:` を指定する。pages ファイル本体は未作成でよい。

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

## スライド作成（1スライド = 1サブエージェント）

各スライドを `v-slide-creator` サブエージェントで作成する（最大5並列）。

1. **1スライドずつ**Agent toolで`v-slide-creator`エージェントを並列起動
2. 全エージェント完了後、出力ファイルの存在を一括確認

**サブエージェント呼び出しプロンプトに含める情報:**

| 情報 | 内容 |
|------|------|
| プレゼンディレクトリ | 生成済みの絶対パス（例: `/home/user/my-talk/`） |
| レイアウト名 | 使用するレイアウト（`slide_theme` の `data.layouts[].layout` の値） |
| 分類と選定理由 | プランで決めた見せ方の分類と、同一分類の他レイアウト候補との比較を含む 1 行以上の文 |
| スライド仕様 | タイトル、要点、メディアヒント |
| プレゼン全体情報 | タイトル、対象者、全体アウトライン |
| 前後スライド | 前スライドの要約、次スライドのタイトル |
| 出力パス | `<プレゼンディレクトリ>/pages/{name}.md` |
| 図表ファイルパス | 対応するdrawioファイルの`xmlSrc`パス（例: `/slides/diagrams/workflow-overview.drawio`）。v-diagram-creatorが作成済みのパスを指定 |

**目次のスライドは最後に作成する。** 全スライドの構成が確定してからスライド番号を正確に反映できる。

**ファイル命名:** `{英語名}.md`（例: `title-slide.md`）。数字で始めない（`01-title-slide.md` は lint 違反）

## スライド固有アセット

`slide_create`（SKILL.md Step 1 と同じ）が以下を自動生成する。**`slides/` 直下にファイルを置かない。必ずサブディレクトリに入れる。**

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
応答の `data.url` をユーザーに伝えて動作確認を依頼する。停止は `stop: true` で行う。

**PPTX 変換（任意）。** PPTX が必要なときは、`pecot-visual` サーバの `slide_convert`（`project_dir`: プレゼンディレクトリの絶対パス）で生成する。

出力先は `<プレゼンディレクトリ>/pptx/<slides.md の title>.pptx`。title のファイル名不可文字は `_` に正規化する。title が無ければ `<basename>.pptx`。

差分キャッシュは初期状態で有効で、2 回目以降は未変更スライドの変換をスキップする。変更が想定どおり反映されないときは `cache: false` を指定して変換する（詳細は SKILL.md Step 5）。
