---
name: v-evidence
description: |
  スクリーンショット画像を統一フォーマットの作業エビデンス xlsx にまとめます。
  Use when the user has screenshots and wants them compiled into an evidence workbook — collects title, captions, order, and annotations interactively, then generates the xlsx. Triggers: "エビデンス作成", "エビデンスxlsx", "スクリーンショットをxlsxに", "作業証跡".
  Do NOT use for diagrams (use v-drawio) or slide decks (use v-slidev).
when_to_use: "作業の証跡を残したい、スクリーンショットをエビデンス表にまとめたい"
argument-hint: "[画像のパス]"
---

# 作業エビデンス xlsx 生成

ユーザーが用意したスクリーンショット画像を、通し番号・キャプション・注記つきの統一フォーマット xlsx にまとめる。

## 概要

処理は 4 段階で進む。

1. 対話で画像・タイトル・キャプション・並び順・注記を収集する
2. エビデンス仕様 JSON（EvidenceSpec）を組み立てて書き出す
3. `pecot-visual` サーバの `evidence_create` を実行して xlsx を生成する
4. 生成パス・項目数・除外された画像をユーザーに報告する

スクリーンショットの撮影・取得はこのスキルの責務ではない。画像はユーザーが用意済みのものを受け取る。

書式の詳細（全フィールド・記入例・座標換算・エラー対応表）は `references/evidence-spec.md` を参照する。

## 1. 対話での収集

ユーザーに設定ファイルを書かせない。以下をすべて対話で聞き取り、仕様 JSON はスキルが組み立てる。

| 収集項目 | 未指定時の扱い |
|---|---|
| 画像群（フォルダ指定またはファイル列挙） | 必須。聞き取れなければ質問する |
| タイトル | 必須。指示に無ければスキルが発明せず質問する（空文字は検証エラーになる） |
| 作成日 | 当日の日付（`YYYY-MM-DD`）を既定にする |
| 各画像のキャプション | `caption` キー自体を省略する（`evidence_create` がファイル名の拡張子を除いた部分で補完する） |
| 並び順 | ファイル名の自然順で `items` を構成する |
| 追加ヘッダー（作成者・環境など） | `extraHeaders` を省略する |
| 注記（吹き出し・強調枠・矢印） | 注記なしで画像のみ配置する |

収集時の注意:

- **必須項目（画像群・タイトル）が揃わないまま生成に進まない。** 足りない項目は推測や作業文脈からの発明で
  補わず、質問だけを返してユーザーの回答を待つ。既定値で埋めてよいのは表で既定を定義した項目だけ
- **対応形式は PNG と JPEG のみ**。これは画像を聞き取る段階でユーザーに伝える。WebP / GIF / SVG などが含まれていると
  `unsupported-format` として除外され、その画像は xlsx に載らない
- 並び順は `evidence_create` 側に既定がなく、`items` の配列順がそのまま通し番号と縦並び順になるため、スキルが決めて組み立てる。
  自然順の定義とゼロ埋め時の注意は `references/evidence-spec.md` を参照する
- キャプションの「未指定」は `caption` キーを書かないことで表す。空文字を明示すると空のキャプションがそのまま出力される

## 2. 注記座標の解決

注記の位置は 0.0–1.0 の相対値（原点は画像左上）で指定する。ユーザーは「送信ボタンのところ」のような言葉で指示するため、
スキルが解決する。

1. 対象画像を Read で実際に閲覧する
2. 指示された箇所の画像内位置を読み取り、相対値へ換算する（換算手順は `references/evidence-spec.md`）
3. 指示が曖昧で対象を 1 つに絞れない場合（同種のアイコンが複数並んでいる等）は、**生成に進まず**、候補を挙げて
   ユーザーに確認する。「いったん推測で置いて、違ったら直す」という進め方はしない

## 3. 注記を組み立てるときの制約

- callout の `text` に改行は入れられない（検証エラー）。文言は 1 行に整形する。折り返しは `box` の幅で自動的に行われる
- callout の文言が長くてもフォントは縮小されず、`box` からあふれて描画される。`w` / `h` は**表示寸法基準**で見積もる
  （見積もりの数式は `references/evidence-spec.md`）
- `box` は `x + w ≤ 1` かつ `y + h ≤ 1` を満たす必要がある。画像からはみ出す指定はクランプされず検証エラーになる
- arrow は `from` と `to` が同一座標の場合、検証エラーになる。純水平・純垂直の矢印は指定してよい
- callout の `anchor`（引き出し線の指し先）は `box` の外側でよい。むしろ対象を指すため通常は外側になる
- highlight の `box` は `w > 0` かつ `h > 0`

## 4. 実行

1. 出力先ディレクトリを作る。**`evidence_create` は `out_path` の親ディレクトリを作らない**ため、
   無いまま呼ぶと `output-write-failed` で失敗する

   ```bash
   mkdir -p <出力先ディレクトリの絶対パス>
   ```

2. 仕様 JSON を `<出力先ディレクトリ>/<name>-spec.json` として書き出す
3. `pecot-visual` サーバの `evidence_create` を呼ぶ
   - `input_path`: 仕様 JSON の絶対パス
   - `out_path`: 出力 xlsx の絶対パス

- 仕様 JSON と出力 xlsx の既定の置き場はどちらも `<project_root>/.pecotv/work/evidence/` 配下の絶対パス。
  ユーザーが出力先を指定した場合はそちらへ出す。`.pecotv/work/` は git 管理から外れているため、実行先リポジトリを汚さない
- **`imagePath`・`input_path`・`out_path` はすべて絶対パスで組み立てる。**
  `input_path` / `out_path` の相対パスは実行前に拒否される。
  `imagePath` の相対パスは、仕様 JSON の位置ではなくプロセスのカレントディレクトリ基準で解決される。そのため画像が `not-found` になる
- 報告は応答の `data` を読んで行う

## 5. エラー処理

失敗は 2 系統ある。

- **絶対パス違反**（`input_path` / `out_path` に相対パスを渡した）: `ok: false` / `exitCode: 2` で、`data` は
  `{"invalidPaths":["out_path=..."]}` のみ。`kind` は `invalid-path` である。
  `invalidPaths` に挙がった引数を絶対パスに直して呼び直す
- 実行失敗は `ok: false` / `exitCode: 1` で返る。原因は `kind` で読み、`data` は `{"event":"evidence.create.error","reason":"...","detail":"..."}` になる。
  `kind` は 8 値で、それぞれ回復手順が決まっている（対応表は `references/evidence-spec.md`）。
  うち `invalid-option` は引数の検証が先に済むこの場面では返らない

検証エラー（`kind: "invalid-spec"`）は `detail` に全件が `items[0].annotations[0].box.w` 形式のパス付きで列挙される。
1 件ずつ試さず、列挙されたパスをすべて直してから再実行する。

文言に文章規則の違反があると、xlsx は書き出されず `kind: "text-violation"` が返る。
`data.violations[].item` が直す先を名指しする。形は `title` / `items[i].caption` / `items[i].annotations[j].text` で、`i` は 0 始まりの添字を指す。
`j` は `annotations` の添字で、highlight と arrow も数える。callout の `text` だけが判定の対象になる。
`caption` を省いてファイル名で補った項目は、確かめない。
`item` の全件を言い換えてから再実行する。規則・除外は変えない。
判定器が動かなかったときは `kind: "text-lint-failed"` が返る。`detail` を読み、原因を直して再実行する。

## 6. 結果報告

成功時は `ok: true` / `exitCode: 0` が返る。`data` は
`{"event":"result","outPath":...,"items":...,"annotations":...,"skipped":[...]}` になる。この `data` を正として報告する。

- 生成した xlsx の**絶対パス**（`outPath`）
- 配置した項目数（`items`）と注記数（`annotations`）
- 除外された画像があれば、`skipped` の各エントリのパスと理由をすべて列挙する。除外は警告で、実行自体は成功する。そのため、省略せず必ず報告する

注記が 1 件も配置できなくても、有効画像が 1 件以上あれば成功で終わる。`annotations` が指示した注記数と食い違う場合は、
注記を付けた画像が `skipped` に含まれていないか確認する。

**注記の見た目（文言のあふれ・位置ずれ）はユーザーの目視確認で最終的に判断する。** 生成後は xlsx を開いて確認するよう案内し、
指摘があれば座標・文言を直して再生成する。これを指摘が無くなるまで繰り返す。
