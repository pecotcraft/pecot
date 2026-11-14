# EvidenceSpec 書式リファレンス

`evidence_create` の `input_path` に渡す仕様 JSON の書式・検証規則・エラー対応。

## 全体の規則

- 未知のキーは検証エラーになる。キー名の打ち間違いは無視されない
- 検証エラーは最初の 1 件で打ち切られず、全件がパス付きで返る
- 座標・サイズはすべて対象画像に対する相対値（0.0–1.0、原点は画像左上）。範囲外は検証エラー

## EvidenceSpec（ルート）

| フィールド | 型 | 必須 | 検証規則 |
|---|---|---|---|
| `title` | string | ✓ | 空文字不可。ヘッダーのタイトル行になる |
| `createdDate` | string | ✓ | `YYYY-MM-DD` 形式かつ暦に実在する日付（`2026-02-30` は拒否）。既定は当日 |
| `extraHeaders` | HeaderField[] | – | 省略可・0 件可 |
| `items` | EvidenceItem[] | ✓ | 1 件以上。配列順がそのまま通し番号（1 始まり）と縦並び順になる |

### HeaderField

| フィールド | 型 | 必須 | 検証規則 |
|---|---|---|---|
| `label` | string | ✓ | 空文字不可（例: `作成者`） |
| `value` | string | ✓ | 空文字可（明示的な空欄を許す） |

### EvidenceItem

| フィールド | 型 | 必須 | 検証規則 |
|---|---|---|---|
| `imagePath` | string | ✓ | 空文字不可。絶対パスで書く。PNG / JPEG のみ有効で、それ以外・読込不能は警告付きで除外される |
| `caption` | string | – | キー自体を省略した場合のみファイル名（拡張子を除いた部分）で補完される。空文字を明示するとそのまま空になる |
| `annotations` | Annotation[] | – | 省略可・0 件可 |

### Annotation

`type` で判別する。`callout` / `highlight` / `arrow` 以外の値は検証エラー。

| `type` | 追加フィールド | 検証規則 |
|---|---|---|
| `callout`（吹き出し） | `text: string`, `box: Rect`, `anchor: Point` | `text` は空文字不可・改行不可。`anchor` は引き出し線の指し先で `box` の外側でよい |
| `highlight`（強調枠） | `box: Rect` | `box.w > 0` かつ `box.h > 0` |
| `arrow`（矢印） | `from: Point`, `to: Point` | `from` と `to` が同一座標だと検証エラー。純水平・純垂直は可 |

### Point / Rect

| 型 | フィールド | 検証規則 |
|---|---|---|
| `Point` | `x`, `y` | それぞれ 0.0–1.0 の有限数 |
| `Rect` | `x`, `y`, `w`, `h` | それぞれ 0.0–1.0 の有限数。さらに `x + w ≤ 1` かつ `y + h ≤ 1`。はみ出しはクランプされず検証エラー（等号は受理。丸め誤差の許容はないため、スキル側で丸めた後の値が条件を満たすことを確認してから渡す） |

## 記入例

```json
{
  "title": "ログイン機能 動作確認エビデンス",
  "createdDate": "2026-08-19",
  "extraHeaders": [
    { "label": "作成者", "value": "K. Hayakawa" },
    { "label": "環境", "value": "検証環境 (stg)" }
  ],
  "items": [
    {
      "imagePath": "/abs/path/shots/01-login.png",
      "caption": "ログイン画面を表示",
      "annotations": [
        {
          "type": "callout",
          "text": "この欄に検証用アカウントを入力する",
          "box": { "x": 0.52, "y": 0.12, "w": 0.36, "h": 0.08 },
          "anchor": { "x": 0.44, "y": 0.33 }
        },
        {
          "type": "highlight",
          "box": { "x": 0.30, "y": 0.28, "w": 0.22, "h": 0.09 }
        }
      ]
    },
    {
      "imagePath": "/abs/path/shots/02-dashboard.png",
      "annotations": [
        {
          "type": "arrow",
          "from": { "x": 0.20, "y": 0.55 },
          "to": { "x": 0.41, "y": 0.32 }
        }
      ]
    }
  ]
}
```

2 件目は `caption` を省略しているため、キャプションは `02-dashboard` になる。

## 座標の換算手順

1. 対象画像を Read で閲覧し、注記したい箇所の位置を画像内で読み取る
2. 相対値に直す（`W` / `H` は基準にした画像の幅・高さ）

   ```text
   x = 左端px / W        y = 上端px / H
   w = 幅px   / W        h = 高さpx / H
   ```

3. 小数 2–3 桁に丸め、`x + w ≤ 1` と `y + h ≤ 1` を丸めた後の値で確認する

相対値なので、閲覧時に画像が縮小表示されていても比率は変わらない。読み取りに使った画像の幅・高さで割ればよい。

## callout の box 寸法の見積もり

文言が `box` に対して長いとフォントは縮小されず、そのままあふれて描画される。表示寸法を基準に必要な `w` / `h` を見積もる。

1. 表示寸法を出す（表示幅は 960px が上限で、原寸がそれ以下なら原寸のまま）

   ```text
   表示幅px = min(960, 原寸幅px)
   表示高px = 表示幅px × 原寸高px / 原寸幅px
   ```

2. `box` の実幅を出す

   ```text
   box幅px = w × 表示幅px
   ```

3. 文言の幅を出す（11pt / 96dpi。全角 1 文字 ≈ 14.7px、半角 1 文字 ≈ 7.3px）

   ```text
   文字幅合計px = 全角文字数 × 14.7 + 半角文字数 × 7.3
   行数 = ceil(文字幅合計px / box幅px)
   ```

4. 必要な高さを相対値に戻す（行送りは 1.2 倍で見る）

   ```text
   h ≥ 行数 × 14.7 × 1.2 / 表示高px
   ```

同じ `w` でも、表示幅が狭い画像ほど `box幅px` が小さくなる。その分、収まる文字数が減る。画像ごとに計算する。

計算例: 原寸 1280×800 の画像に `w = 0.30`、全角 17 文字の文言を置く場合。

```text
表示幅px = min(960, 1280) = 960
表示高px = 960 × 800 / 1280 = 600
box幅px  = 0.30 × 960 = 288
文字幅合計px = 17 × 14.7 = 249.9
行数 = ceil(249.9 / 288) = 1
h ≥ 1 × 14.7 × 1.2 / 600 = 0.0294   → 余裕を見て h = 0.05
```

## 並び順（自然順）

ユーザーが並び順を指定しない場合は、ファイル名の自然順で `items` を構成する。

- 定義: 文字列中の数値部分を数値として比較する（`Intl.Collator(undefined, { numeric: true })` 相当）
- `img2.png` < `img10.png` になる（単純な辞書順では逆になる）
- ゼロ埋めの有無が混在すると結果が直感とずれる場合がある（`img01.png` と `img1.png` の混在など）。
  並びが自明でないときはユーザーに確認する

## 画像の除外（skip）

有効でない画像は警告付きで除外され、その項目は xlsx に載らない。除外があっても有効画像が 1 件以上あれば実行は成功する。
除外分は通し番号から詰められるため、番号に欠番は出ない。

| `reason` | 条件 | 対応 |
|---|---|---|
| `not-found` | パスにファイルが存在しない | パスをユーザーに確認する。相対パスを渡していないか確認する |
| `unsupported-format` | PNG / JPEG 以外（WebP・GIF・SVG など） | 対応形式に変換してもらうか、対象から外すことをユーザーに確認する |
| `unreadable` | 存在するが読めない（権限不足・ディレクトリ指定・ヘッダが破損している・途中で切れている） | ファイルの状態をユーザーに確認する |

## エラー（`evidence.create.error`）

実行失敗の応答は `ok: false` / `exitCode: 1` で返る。`data` は `{"event":"evidence.create.error","reason":"...","detail":"..."}` になる。
絶対パス違反だけは別系統で、`exitCode: 2` かつ `kind` は `invalid-path` になる。
`data` は `{"invalidPaths":[...]}` のみで、`event` と `reason` を持たない。
下の表の名前は `kind` で読む。`data.reason` にも同じ値が入る。
出力ファイルの保証は次節の `exitCode` 表にまとめている（`exitCode: 1` は `output-write-failed` かどうかで異なる）。

| `kind` | 条件 | `exitCode` | 回復手順 |
|---|---|---|---|
| `input-not-found` | `input_path` の仕様 JSON が読めない | 1 | 仕様 JSON を書き出したか確認し、`input_path` を絶対パスで組み直す |
| `invalid-json` | 仕様 JSON の parse に失敗 | 1 | 書き出した JSON を読み直し、構文（末尾カンマ・引用符など）を直す |
| `invalid-spec` | 検証エラー | 1 | `detail` に全件がパス付きで列挙される。座標・文言を再計算し、列挙されたものをすべて直してから再実行する |
| `invalid-option` | オプション指定が不正 | – | 引数は呼び出し前に検証されるため、この場面では返らない |
| `no-valid-images` | `items` の全件が除外され有効画像が 0 件 | 1 | 画像パスと形式をユーザーに再確認する |
| `text-violation` | 文言が文章規則に当たる | 1 | `data.violations[].item`（`title` / `items[i].caption` / `items[i].annotations[j].text`。`i` は 0 始まり、`j` は highlight・arrow も数える）の全件を言い換えて再実行する。規則・除外は変えない |
| `text-lint-failed` | 文章規則の判定器が動かない | 1 | `detail` を読み、原因を直して再実行する |
| `output-write-failed` | `out_path` へ書き出せない | 1 | `out_path` の親ディレクトリを `mkdir -p` する。書き込み権限とパスの綴りを確認する |

## exitCode と成功時の応答

| `exitCode` | 条件 | 出力ファイルの保証 |
|---|---|---|
| 0 | 生成成功。除外警告があっても有効画像が 1 件以上あれば成功 | xlsx を書き出し済み |
| 1 | 仕様 JSON の読込・parse・検証エラー、有効画像 0 件、または書き出し失敗 | 入力不正・文言の違反・有効画像 0 件では出力に触れない（既存の `out_path` を壊さない）。書き出し失敗（`output-write-failed`）では部分生成物が残り得るため、残った `out_path` は成果物として扱わず削除してから再実行する |
| 2 | `input_path` / `out_path` に相対パスを渡した。実行前に拒否され `data.invalidPaths` に該当引数が載る | xlsx を書き出さない |

成功時の `data`:

```json
{ "event": "result", "outPath": "/abs/path/evidence.xlsx", "items": 5, "annotations": 3,
  "skipped": [ { "path": "/abs/path/broken.png", "reason": "unreadable" } ] }
```

同名の xlsx が既にある場合は警告なく上書きされる。
