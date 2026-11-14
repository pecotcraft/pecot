---
name: v-drawio
description: |
  draw.io のダイアグラムを生成し、ブラウザで直接開ける URL を書き出したファイルとして出力します。
  Use when the user wants a diagram — AWS (aws4) / Azure (azure2) architecture, infographic, comparison, dashboard, timeline, poster/report visual. Triggers: "draw.io", "構成図", "アーキテクチャ図", "ポスター", "可視化", "障害分析".
  Do NOT use for slide decks (use v-slidev) or screenshot evidence xlsx (use v-evidence).
when_to_use: "構成図や図解を作りたい、ポスターやインフォグラフィックにしたい、draw.io で描きたい"
argument-hint: "[図の内容]"
---

# draw.io ダイアグラム生成

draw.ioのXMLダイアグラムを生成し、ブラウザで直接開けるリンクとして出力する。

## 出力手順

1. draw.ioのmxGraphModel形式でXMLを生成し、出力先に保存する
   - **デフォルト:** `<project_root>/.pecotv/work/drawio/` 配下の絶対パス
   - **指定あり:** ユーザーが出力先を指定した場合はそちらに保存する
2. XMLファイルを `pecot-visual` サーバの `drawio_create` に渡し、`out_path` で表示用 HTML へ直接書き出す
3. **表示用 HTML のパスのみ** をユーザーに案内する。URL 文字列そのものは **絶対に画面へ表示しない**

`drawio_create` の引数:

- `input_path`: 入力 `.drawio` ファイルの絶対パス
- `out_path`: 表示用 HTML（`.html`。ダブルクリックすると既定ブラウザで開き draw.io へリダイレクトする）の絶対パス（例: `<file.drawio>.html`）。**必ず指定する**
- `theme`: 任意。テーマの指定で、talk-dir のパス・`git+https://...#<tag>`・`file:<path>` のどれか。図の書体と文字サイズ（5 段）の確認に使う宣言を、次の優先順で決める
  1. `theme`
  2. 図の祖先の talk-dir（図がその `public/` の下にあるとき）
  3. 既定値（書体 `sans-serif`）
  書体は常に確かめ、5 段のサイズはテーマが決まったときだけ確かめる。総称 `monospace` を含む書体の並びは、書体の確認の対象外である。
  talk-dir の中の図は、`slide_theme` の `declaration.fonts`（`body`・`eastAsian`）と `fontSizes` の値で描く。
  図を talk-dir の `public/` の下に置くときは、`theme` を渡さない。図の位置からテーマが決まる。
  既定の出力先（`.pecotv/work/drawio/`）は talk-dir の外にある。外に置くスライド用の図だけ、`theme` に talk-dir を渡す
- 図のセルの `fontFamily` は、次の順に書く。
  1. 宣言の `fonts.body`
  2. `eastAsian`（`body` に無ければ）
  3. 末尾に `sans-serif`

  書式は `fontFamily=<body の書体>, <eastAsian>, sans-serif` である。
  例えば `body` が `Test Sans`、`eastAsian` が `Test Sans JP` なら、`fontFamily=Test Sans, Test Sans JP, sans-serif` と書く。
  宣言が無いときは `fontFamily=sans-serif` だけを書く
- `png`: 既定 `true` で、`out_path` の拡張子を `.png` に置換した兄弟ファイルへ、実描画 PNG を同時出力する。PNG が不要なときだけ `false` にする

`out_path` の親ディレクトリは自動で作成される。応答の `data` には、表示用 HTML のパス（`file`）・PNG のパス（`png`）・PNG 生成の可否（`pngFailed`）が載る。
確かめた宣言は `data.theme` に載る。中身は `source`・`name`・`fonts` で、サイズを確かめたときは `fontSizes` も載る。

### 注意

- **`out_path` は必ず指定すること。** 省略すると応答の `data.url` に URL 本体が載り、そのままコンテキストに入る
- **Read してよいのは常に `.drawio.png` の方。** 表示用 HTML（`.drawio.html`）は巨大な base64 URL の器であり Read しない（コンテキストウィンドウを消費する）
- **URL 文字列そのものを画面（assistant 出力）に表示することは禁止。** `cat`/`echo` 等で URL を吐き出すのも禁止。`out_path` で書き出した **表示用 HTML のパス** をユーザーに案内する。これは Read 経由と応答経由のどちらでも同じである。URL 本体は base64 を含み巨大で、コンテキスト・チャットログを汚染する
- PNG ファイル（`<file.drawio>.png`）は Read して品質チェックに使ってよい。
  diagrams.net の viewer で、テーマの宣言の書体を読み込んで描いた図の画像。スライドに置いたときと同じ字幅で折り返すので、はみ出しや揃いはこの PNG で判断できる。
  draw.io 公式の「XML 埋め込み PNG (`.drawio.png`)」形式である。draw.io や VS Code 拡張で開けば、ダイアグラムとして再編集できる。ただし埋め込まれるのは `icon://` を data URI に展開した解決後の XML である。編集は `.drawio` 側で行う（PNG を直接編集しても `.drawio` からの再生成に反映されず枝分かれする）
  - PNG は図の XML ソースを内包するため、ラスター画像のみを配布したい場合は `--no-png`（MCP は `png: false`）を指定する
- XML内のvalue属性にHTML実体参照（`&lt;font&gt;`等）を含めるのは問題ない
- エッジ（edge）には必ず `<mxGeometry relative="1" as="geometry"/>` を含める（省略するとVSCodeでキャンバスが崩れる）
- 図のラベルに文章規則の違反があると、`drawio_create` は何も書き出さず `kind: text-violation` と `data.violations[].item` を返す。
  `item` は `mxCell id="..."` の形で、直す先のセルを名指しする。`<object>` や `<UserObject>` で包んだセルは、包んだ側の `label` が直す先になる。
  `html=1` のセルは、タグを除いた文言で判定される。全件を直してから `drawio_create` を再実行する。規則・除外は変えない
- 判定器が動かなかったときは `kind: text-lint-failed` が返り、同じく何も書き出さない。
  `data.detail` を読み、圧縮形式の XML が原因なら、非圧縮の XML で保存し直して再実行する
- `icon://` 参照は `drawio_create` が自動的にdata URIに変換して埋め込む
  - アイコンカタログのルートは `${CLAUDE_PLUGIN_ROOT}/assets/drawio-icons/`（`ls` で選定する際はこの絶対パスを使う）
  - 中身は Lucide（ISC）の線画アイコンで、`icon://<分類>/<名前>#<色>` の形で指す。例は `icon://development/server#1f2937`、`icon://weather/cloud`
  - 分類は Lucide の分類の先頭の 1 つ
  - `#<色>` は線の色（`#` なしの 16 進）で、省略すると黒になる

---

## XML基本構造

すべてのダイアグラムは次の構造を共有する。

```xml
<mxfile>
<diagram name="{名前}">
<mxGraphModel page="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1">
<root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <!-- 要素をここに配置 -->
</root>
</mxGraphModel>
</diagram>
</mxfile>
```

`page="0"` でページ枠を無効化し、要素に合わせたコンパクトな配置とする。

---

## 用途別スタイルリファレンス

用途に応じて以下の DESIGN.md（[Google DESIGN.md 仕様](https://github.com/google-labs-code/design.md) 準拠）を読み込む。
**スタイル名列がプラグイン全体で使う正準識別子** で、この表が名前・用途・パスの対応の基準:

| スタイル名 | 用途 | 設計仕様（DESIGN.md） |
|-----------|------|-------------|
| `aws` | AWS 構成図 | `references/architecture/aws/DESIGN.md` |
| `azure` | Azure 構成図 | `references/architecture/azure/DESIGN.md` |
| `infographic/ja` | スライドや発表に添える日本語ラベルの図 | `references/infographic/ja/DESIGN.md` |
| `infographic/en` | スライドや発表に添える英語ラベルの図 | `references/infographic/en/DESIGN.md` |
| `poster/general` | ポスター・報告書（レイアウト指定のない一枚絵） | `references/poster/general/DESIGN.md` |
| `poster/swimlane-flow` | スイムレーン処理フロー図（工程列 × 役割レーン） | `references/poster/swimlane-flow/DESIGN.md` |

`poster/` 配下はレイアウトの種類ごとに分かれており、各ファイルが poster 系トークンとレイアウト規範を 1 枚で完結して持つ（今後この表にレイアウトを追加していく）。
レイアウトが定まった依頼はそのレイアウトのスタイルを、レイアウト指定のない一枚絵の依頼は `poster/general` を選ぶ。両者は排他で、併読しない。

---

## 生成フロー

ダイアグラムは必ず `v-diagram-creator` サブエージェントを使って生成する。自分で直接XMLを書かないこと。

### Step 1: 用途とスタイルを決定する

ユーザーの要件から用途を判断し、対応するスタイルリファレンスのパスを決定する。

### Step 2: v-diagram-creator を起動する

用途で並列数を切り替える。`subagent_type: "v-diagram-creator"` の Agent ツールを呼び出す点は共通。

各エージェントのプロンプトに共通で含める項目:

- ユーザーの要件（何を図にするか）
- Step 1 で決定したスタイルリファレンスのパス
- 出力先ファイルパス

出力先のデフォルトは `<project_root>/.pecotv/work/drawio/`（「出力手順」参照）。`v-diagram-creator` 起動時はこの絶対パス配下を出力先として渡す。

各 v-diagram-creator は内部で表示用 HTML と同時に実描画 PNG を生成する。その PNG を自身で `Read` して「はみ出し・重なり・折り返し失敗・サイズ過大」を判定し、崩れがあれば XML を直して再生成する自己検証ループを回す。

#### infographic 用途（4 並列）

用途が **infographic**（Step 1 で `infographic/ja` か `infographic/en` を選んだケース）の場合のみ 4 並列。レイアウトの差が成果に影響するため、1 メッセージで Agent ツールを 4 つ同時に呼び出す。

- 出力先は連番で重複させない: `diagram-N.drawio`（N=1..4）
- 4 体には同じ要件を渡し、レイアウトの型や見せ方の系統を割り当てない。レイアウトは各エージェントが要件の主張から独立に設計する

#### それ以外の用途（1 並列）

infographic 以外の用途は 1 並列に固定する。いずれも「実体に対応する構成」を描く性質で複数案の意義が薄く、時間とトークンの消費が大きいため。

- Agent ツールは 1 回だけ呼び出す
- 出力先は単一ファイル名でよい（例: `diagram.drawio`）
- アプローチの割り当ては不要

### Step 3: PNG を確認してユーザーに提示する

判定観点はサブエージェントと同じ（はみ出し・重なり・折り返し失敗・サイズ過大）に加え、ユーザー要件への適合度。

- infographic 用途では、4 枚の PNG を `Read` して横並びで比較する。
  4 枚の出力は `diagram-N.drawio` / `diagram-N.drawio.html` / `diagram-N.drawio.png`（N=1..4、Step 2 の連番と対応）である。
  問題のあるものを除外したうえで、残った候補の **表示用 HTML のパス** をユーザーに提示（URL 文字列本体は画面に出さない）し、好みのものを選んでもらう
- それ以外の用途では、1 枚の PNG を `Read` して崩れが無いことを確認し、表示用 HTML のパスをユーザーに提示（URL 文字列本体は画面に出さない）する
